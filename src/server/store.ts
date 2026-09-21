import { createRequire } from 'node:module';
// Loaded via require so bundlers (vite/vitest) do not try to resolve the
// newer node:sqlite builtin through their module graph.
const nodeRequire = createRequire(import.meta.url);
type DatabaseSync = import('node:sqlite').DatabaseSync;
const { DatabaseSync } = nodeRequire('node:sqlite');
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildDependents, compareFingerprints, fingerprint, outputSetHash, reachable } from '../core/fingerprint';
import { frame, sha256 } from '../core/encode';
import {
  BASELINE_RULE_VERSION,
  dryRun as coreDryRun,
  type ObservationRecord,
} from '../core/rules';
import type {
  ActionSpec,
  DryRunResult,
  Fingerprint,
  FingerprintComparison,
  Manifest,
  NormalizationRule,
  ResolvedDep,
  RuleVersion,
} from '../core/types';

export interface ImportChunkAck {
  jobId: string;
  receivedChunks: number;
  totalChunks: number;
  status: 'receiving' | 'finalized';
  manifestId?: string;
}

export interface ActionRow {
  actionId: string;
  command: string;
  argv: string[];
  cwd: string;
  envWhitelist: string[];
  deps: string[];
  latestResultVersion: number | null;
  trusted: boolean;
  distrustReason: string | null;
  observations: ObsRow[];
}

export interface ObsRow {
  actionId: string;
  resultVersion: number;
  manifestId: string;
  observedAt: number;
  status: 'success' | 'failed';
  key: string | null;
  ruleVersion: number | null;
  outputSetHash: string | null;
  trusted: boolean;
  distrustReason: string | null;
  spec: ActionSpec;
  pinned: ResolvedDep[];
  firstOrder: number;
}

export interface DisputeRow {
  id: number;
  ruleVersion: number;
  key: string;
  firstResultVersion: number;
  secondResultVersion: number;
  firstActionId: string;
  secondActionId: string;
  firstOutputHash: string;
  secondOutputHash: string;
  firstObservedAt: number;
  secondObservedAt: number;
  firstManifestId: string;
  secondManifestId: string;
  status: 'open' | 'resolved';
  note: string;
}

export interface CorrectionRow {
  id: number;
  actionId: string;
  inputPath: string;
  badDigest: string;
  correctDigest: string;
  createdAt: number;
  affectedActions: string[];
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_versions (
  version INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','draft','archived')),
  parent_version INTEGER,
  rules_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE TABLE IF NOT EXISTS manifests (
  manifest_id TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  job_id TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  action_id TEXT PRIMARY KEY,
  first_manifest_id TEXT NOT NULL,
  latest_result_version INTEGER
);

CREATE TABLE IF NOT EXISTS observations (
  result_version INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  output_set_hash TEXT,
  pinned_json TEXT NOT NULL DEFAULT '[]',
  key TEXT,
  rule_version INTEGER,
  trusted INTEGER NOT NULL DEFAULT 1,
  distrust_reason TEXT,
  first_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (action_id) REFERENCES actions(action_id)
);
CREATE INDEX IF NOT EXISTS idx_obs_action ON observations(action_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_key ON observations(rule_version, key);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_version INTEGER NOT NULL,
  key TEXT NOT NULL,
  first_result_version INTEGER NOT NULL,
  second_result_version INTEGER NOT NULL,
  first_action_id TEXT NOT NULL,
  second_action_id TEXT NOT NULL,
  first_output_hash TEXT NOT NULL,
  second_output_hash TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  second_observed_at INTEGER NOT NULL,
  first_manifest_id TEXT NOT NULL,
  second_manifest_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (rule_version, key, first_result_version, second_result_version)
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  input_path TEXT NOT NULL,
  bad_digest TEXT NOT NULL,
  correct_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  affected_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS import_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('receiving','finalized')),
  total_chunks INTEGER NOT NULL,
  received_chunks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_chunks (
  job_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (job_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.ensureBaseline();
  }

  close(): void {
    this.db.close();
  }

  ensureBaseline(): void {
    const row = this.db.prepare('SELECT version FROM rule_versions WHERE version = 1').get() as
      | { version: number }
      | undefined;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO rule_versions (version,label,status,parent_version,rules_json,created_at,approved_at)
           VALUES (1,?,'active',NULL,?, ?, ?)`,
        )
        .run(
          BASELINE_RULE_VERSION.label,
          JSON.stringify(BASELINE_RULE_VERSION.rules),
          BASELINE_RULE_VERSION.createdAt,
          BASELINE_RULE_VERSION.approvedAt ?? null,
        );
    }
  }
}

const now = (): number => Date.now();

// ---------- rule versions ----------

export interface StoreRuleVersion extends RuleVersion {
  id: number;
}

function rowToRule(row: Record<string, unknown>): RuleVersion {
  return {
    version: row.version as number,
    label: row.label as string,
    status: row.status as RuleVersion['status'],
    parentVersion: (row.parent_version as number | null) ?? null,
    rules: JSON.parse(row.rules_json as string) as NormalizationRule[],
    createdAt: row.created_at as number,
    approvedAt: (row.approved_at as number | null) ?? null,
  };
}

Object.assign(Store.prototype, {});

Store.prototype.listRules = function (this: Store): RuleVersion[] {
  const rows = this.db.prepare('SELECT * FROM rule_versions ORDER BY version').all() as Record<string, unknown>[];
  return rows.map(rowToRule);
};

Store.prototype.getActiveRules = function (this: Store): RuleVersion {
  const row = this.db.prepare("SELECT * FROM rule_versions WHERE status='active' ORDER BY version DESC LIMIT 1").get() as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error('no active rule version');
  return rowToRule(row);
};

Store.prototype.getRule = function (this: Store, version: number): RuleVersion {
  const row = this.db.prepare('SELECT * FROM rule_versions WHERE version = ?').get(version) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`unknown rule version ${version}`);
  return rowToRule(row);
};

Store.prototype.createDraft = function (
  this: Store,
  label: string,
  rules: NormalizationRule[],
  baseVersion?: number,
): RuleVersion {
  const base = baseVersion ? this.getRule(baseVersion) : this.getActiveRules();
  const next = (
    this.db.prepare('SELECT MAX(version) AS m FROM rule_versions').get() as { m: number }
  ).m + 1;
  const ts = now();
  this.db
    .prepare(
      `INSERT INTO rule_versions (version,label,status,parent_version,rules_json,created_at,approved_at)
       VALUES (?,?, 'draft', ?, ?, ?, NULL)`,
    )
    .run(next, label, base.version, JSON.stringify(rules), ts);
  this.audit('draft_created', `v${next} 基于 v${base.version}: ${label}`);
  return this.getRule(next);
};

Store.prototype.approveDraft = function (this: Store, version: number): RuleVersion {
  const draft = this.getRule(version);
  if (draft.status !== 'draft') throw new Error(`v${version} 不是草案`);
  const tx = this.db.prepare('BEGIN');
  try {
    tx.run();
    this.db.prepare("UPDATE rule_versions SET status='archived' WHERE status='active'").run();
    this.db
      .prepare("UPDATE rule_versions SET status='active', approved_at=? WHERE version=?")
      .run(now(), version);
    this.db.prepare('COMMIT').run();
  } catch (e) {
    this.db.prepare('ROLLBACK').run();
    throw e;
  }
  this.rekeyAll(version);
  this.rebuildDisputes(version);
  this.audit('rule_approved', `批准规则版本 v${version}`);
  return this.getRule(version);
};

Store.prototype.rollbackRule = function (this: Store, targetVersion: number): RuleVersion {
  const target = this.getRule(targetVersion);
  if (target.status !== 'archived' && targetVersion !== 1) {
    throw new Error('只能回滚到已归档（曾批准）的规则版本');
  }
  const tx = this.db.prepare('BEGIN');
  try {
    tx.run();
    this.db.prepare("UPDATE rule_versions SET status='archived' WHERE status='active'").run();
    this.db
      .prepare("UPDATE rule_versions SET status='active', approved_at=COALESCE(approved_at, ?) WHERE version=?")
      .run(now(), targetVersion);
    this.db.prepare('COMMIT').run();
  } catch (e) {
    this.db.prepare('ROLLBACK').run();
    throw e;
  }
  this.rekeyAll(targetVersion);
  this.rebuildDisputes(targetVersion);
  this.audit('rule_rollback', `回滚到规则版本 v${targetVersion}`);
  return this.getRule(targetVersion);
};

Store.prototype.audit = function (this: Store, kind: string, detail: string): void {
  this.db.prepare('INSERT INTO audit_log (at,kind,detail) VALUES (?,?,?)').run(now(), kind, detail);
};

Store.prototype.listAudit = function (this: Store): { id: number; at: number; kind: string; detail: string }[] {
  return this.db
    .prepare('SELECT * FROM audit_log ORDER BY id')
    .all() as { id: number; at: number; kind: string; detail: string }[];
};

// ---------- crash-recoverable chunked import ----------

function shaText(text: string): string {
  return sha256(frame('manifest', text));
}

Store.prototype.startImport = function (
  this: Store,
  jobId: string,
  totalChunks: number,
): { jobId: string; status: 'receiving'; totalChunks: number; receivedChunks: number } {
  const existing = this.db.prepare('SELECT * FROM import_jobs WHERE job_id=?').get(jobId) as
    | { status: string; total_chunks: number; received_chunks: number }
    | undefined;
  if (existing) {
    return {
      jobId,
      status: 'receiving',
      totalChunks: existing.total_chunks,
      receivedChunks: existing.received_chunks,
    };
  }
  this.db
    .prepare('INSERT INTO import_jobs (job_id,status,total_chunks,received_chunks,created_at) VALUES (?,?,?,0,?)')
    .run(jobId, 'receiving', totalChunks, now());
  return { jobId, status: 'receiving', totalChunks, receivedChunks: 0 };
};

Store.prototype.putChunk = function (
  this: Store,
  jobId: string,
  chunkIndex: number,
  payloadJson: string,
): ImportChunkAck {
  const job = this.db.prepare('SELECT * FROM import_jobs WHERE job_id=?').get(jobId) as
    | { status: string; total_chunks: number; received_chunks: number }
    | undefined;
  if (!job) throw new Error(`未知导入作业 ${jobId}，请先 startImport`);
  if (job.status === 'finalized') {
    return { jobId, receivedChunks: job.total_chunks, totalChunks: job.total_chunks, status: 'finalized' };
  }
  const present = this.db.prepare('SELECT 1 FROM import_chunks WHERE job_id=? AND chunk_index=?').get(jobId, chunkIndex);
  if (!present) {
    this.db
      .prepare('INSERT INTO import_chunks (job_id,chunk_index,payload_json) VALUES (?,?,?)')
      .run(jobId, chunkIndex, payloadJson);
    this.db.prepare('UPDATE import_jobs SET received_chunks = received_chunks + 1 WHERE job_id=?').run(jobId);
  }
  const after = this.db.prepare('SELECT * FROM import_jobs WHERE job_id=?').get(jobId) as {
    total_chunks: number;
    received_chunks: number;
    status: string;
  };
  return {
    jobId,
    receivedChunks: after.received_chunks,
    totalChunks: after.total_chunks,
    status: after.status === 'finalized' ? 'finalized' : 'receiving',
  };
};

/** Rejoin staged chunks in order; durable before derivation, so crash -> re-finalize. */
Store.prototype.finalizeImport = function (this: Store, jobId: string): ImportChunkAck {
  const job = this.db.prepare('SELECT * FROM import_jobs WHERE job_id=?').get(jobId) as
    | { status: string; total_chunks: number; received_chunks: number }
    | undefined;
  if (!job) throw new Error(`未知导入作业 ${jobId}`);
  if (job.status === 'finalized') {
    return { jobId, receivedChunks: job.total_chunks, totalChunks: job.total_chunks, status: 'finalized' };
  }
  if (job.received_chunks !== job.total_chunks) {
    throw new Error(`分片不完整: ${job.received_chunks}/${job.total_chunks}`);
  }
  const chunks = this.db
    .prepare('SELECT payload_json FROM import_chunks WHERE job_id=? ORDER BY chunk_index')
    .all(jobId) as { payload_json: string }[];
  const full = chunks.map((c) => c.payload_json).join('');
  const manifest = JSON.parse(full) as Manifest;
  validateManifest(manifest);

  // Identity is the immutable build-action content, not the envelope: the
  // same manifest re-delivered (different manifest id / job) must dedup.
  const canonical = JSON.stringify(
    [...manifest.actions]
      .map((a) => ({
        id: a.id,
        observedAt: a.observedAt,
        command: a.command,
        argv: a.argv,
        cwd: a.cwd,
        env: a.env,
        envWhitelist: a.envWhitelist,
        toolchain: a.toolchain,
        platform: a.platform,
        inputs: a.inputs,
        deps: a.deps,
        outputs: a.outputs,
        status: a.status,
        exitCode: a.exitCode ?? null,
        errorText: a.errorText ?? null,
      }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : x.observedAt - y.observedAt)),
  );
  const contentHash = shaText(canonical);
  const dup = this.db.prepare('SELECT manifest_id FROM manifests WHERE content_hash=?').get(contentHash) as
    | { manifest_id: string }
    | undefined;

  if (dup) {
    this.db
      .prepare("UPDATE import_jobs SET status='finalized' WHERE job_id=?")
      .run(jobId);
    this.audit('import_dedup', `${manifest.manifestId} 与 ${dup.manifest_id} 内容相同，跳过派生`);
    return {
      jobId,
      receivedChunks: job.total_chunks,
      totalChunks: job.total_chunks,
      status: 'finalized',
      manifestId: dup.manifest_id,
    };
  }

  this.deriveManifest(manifest, contentHash, jobId);
  this.db.prepare("UPDATE import_jobs SET status='finalized' WHERE job_id=?").run(jobId);
  this.audit('import_finalized', `${manifest.manifestId} 已派生 ${manifest.actions.length} 条观察`);
  return {
    jobId,
    receivedChunks: job.total_chunks,
    totalChunks: job.total_chunks,
    status: 'finalized',
    manifestId: manifest.manifestId,
  };
};

Store.prototype.listJobs = function (
  this: Store,
): { jobId: string; status: string; totalChunks: number; receivedChunks: number }[] {
  return (this.db.prepare('SELECT * FROM import_jobs ORDER BY created_at').all() as Record<string, unknown>[]).map(
    (r) => ({
      jobId: r.job_id as string,
      status: r.status as string,
      totalChunks: r.total_chunks as number,
      receivedChunks: r.received_chunks as number,
    }),
  );
};

function validateManifest(m: Manifest): void {
  if (!m.manifestId || typeof m.importedAt !== 'number') throw new Error('清单缺少 manifestId/importedAt');
  if (!Array.isArray(m.actions)) throw new Error('清单 actions 必须是数组');
  const ids = new Set<string>();
  for (const a of m.actions) {
    if (!a.id) throw new Error('动作缺少 id');
    if (ids.has(a.id)) throw new Error(`清单内动作 id 重复: ${a.id}`);
    ids.add(a.id);
    if (!Array.isArray(a.argv) || !Array.isArray(a.envWhitelist) || !Array.isArray(a.deps) || !Array.isArray(a.inputs)) {
      throw new Error(`动作 ${a.id} 字段类型错误`);
    }
    if (typeof a.observedAt !== 'number') throw new Error(`动作 ${a.id} 缺少 observedAt`);
  }
}

// ---------- derivation: order-independent, deterministic ----------

interface StoredObs {
  resultVersion: number;
  actionId: string;
  manifestId: string;
  observedAt: number;
  spec: ActionSpec;
  status: 'success' | 'failed';
  outputSetHash: string | null;
  pinned: ResolvedDep[];
  key: string | null;
  ruleVersion: number | null;
  trusted: boolean;
  distrustReason: string | null;
  firstOrder: number;
}

function loadAllObservations(db: DatabaseSync): StoredObs[] {
  const rows = db.prepare('SELECT * FROM observations ORDER BY result_version').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    resultVersion: r.result_version as number,
    actionId: r.action_id as string,
    manifestId: r.manifest_id as string,
    observedAt: r.observed_at as number,
    spec: JSON.parse(r.spec_json as string) as ActionSpec,
    status: r.status as StoredObs['status'],
    outputSetHash: (r.output_set_hash as string | null) ?? null,
    pinned: JSON.parse((r.pinned_json as string) ?? '[]') as ResolvedDep[],
    key: (r.key as string | null) ?? null,
    ruleVersion: (r.rule_version as number | null) ?? null,
    trusted: Boolean(r.trusted),
    distrustReason: (r.distrust_reason as string | null) ?? null,
    firstOrder: r.first_order as number,
  }));
}

/**
 * Recompute every fingerprint under a rule version. Dependency pinning is
 * stored observation data and stays intact; only key material is re-derived.
 */
Store.prototype.rekeyAll = function (this: Store, ruleVersionNumber: number): void {
  const rule = this.getRule(ruleVersionNumber);
  const obs = loadAllObservations(this.db);
  const stmt = this.db.prepare(
    'UPDATE observations SET key=?, rule_version=? WHERE result_version=?',
  );
  // SAVEPOINT nests safely inside the import transaction as well as running
  // standalone from approve/rollback.
  this.db.exec('SAVEPOINT rekey_all');
  try {
    for (const o of obs) {
      const fp = fingerprint(o.spec, rule.rules, o.pinned, rule.version);
      stmt.run(fp.key, rule.version, o.resultVersion);
    }
    this.db.exec('RELEASE SAVEPOINT rekey_all');
  } catch (e) {
    this.db.exec('ROLLBACK TO SAVEPOINT rekey_all');
    this.db.exec('RELEASE SAVEPOINT rekey_all');
    throw e;
  }
};

Store.prototype.deriveManifest = function (
  this: Store,
  manifest: Manifest,
  contentHash: string,
  jobId: string,
): void {
  const active = this.getActiveRules();
  // Import shuffled? Order only by the declared observation timestamp, then
  // id for full determinism.
  const ordered = [...manifest.actions].sort((a, b) =>
    a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : 1,
  );

  const prior = loadAllObservations(this.db);
  const globalOrder = prior.length ? Math.max(...prior.map((o) => o.firstOrder)) : 0;

  this.db.exec('SAVEPOINT derive_manifest');
  try {
    this.db
      .prepare('INSERT OR IGNORE INTO manifests (manifest_id,imported_at,content_hash,job_id) VALUES (?,?,?,?)')
      .run(manifest.manifestId, manifest.importedAt, contentHash, jobId);

    const insertAction = this.db.prepare(
      'INSERT OR IGNORE INTO actions (action_id,first_manifest_id,latest_result_version) VALUES (?,?,?)',
    );
    const insertObs = this.db.prepare(
      `INSERT INTO observations
       (action_id,manifest_id,observed_at,spec_json,status,output_set_hash,pinned_json,trusted,first_order)
       VALUES (?,?,?,?,?,?,?,1,?)`,
    );
    const newOnes: StoredObs[] = [];
    let orderCounter = globalOrder;
    for (const spec of ordered) {
      // Pinned dep result = the dep's latest observation strictly before this
      // one; ties resolved by first-order. Failure is pinned too.
      const pinned: ResolvedDep[] = spec.deps
        .slice()
        .sort()
        .map((depId) => {
          const candidates = prior
            .filter((o) => o.actionId === depId && o.observedAt <= spec.observedAt)
            .concat(newOnes.filter((o) => o.actionId === depId));
          if (!candidates.length) {
            throw new Error(`动作 ${spec.id} 依赖尚未导入的动作 ${depId}`);
          }
          const chosen = candidates.reduce((best, c) =>
            c.observedAt > best.observedAt ||
            (c.observedAt === best.observedAt && c.firstOrder > best.firstOrder)
              ? c
              : best,
          );
          return {
            actionId: depId,
            resultVersion: chosen.resultVersion,
            outputSetHash: chosen.outputSetHash ?? '',
            status: chosen.status,
          };
        });

      const osh = spec.status === 'success' ? outputSetHash(spec.outputs) : null;
      orderCounter += 1;
      // parent action row must exist before the observation (FK constraint)
      insertAction.run(spec.id, manifest.manifestId, 0);
      const info = insertObs.run(
        spec.id,
        manifest.manifestId,
        spec.observedAt,
        JSON.stringify(spec),
        spec.status,
        osh,
        JSON.stringify(pinned),
        orderCounter,
      );
      this.db.prepare('UPDATE actions SET latest_result_version=? WHERE action_id=?').run(
        Number(info.lastInsertRowid),
        spec.id,
      );
      newOnes.push({
        resultVersion: Number(info.lastInsertRowid),
        actionId: spec.id,
        manifestId: manifest.manifestId,
        observedAt: spec.observedAt,
        spec,
        status: spec.status,
        outputSetHash: osh,
        pinned,
        key: null,
        ruleVersion: null,
        trusted: true,
        distrustReason: null,
        firstOrder: orderCounter,
      });
    }

    this.reapplyDistrust();
    this.rekeyAll(active.version);
    this.rebuildDisputes(active.version);
    this.db.exec('RELEASE SAVEPOINT derive_manifest');
  } catch (e) {
    this.db.exec('ROLLBACK TO SAVEPOINT derive_manifest');
    this.db.exec('RELEASE SAVEPOINT derive_manifest');
    throw e;
  }
};

/**
 * Recompute trust from correction records. Only actions reachable through the
 * DAG from a corrected input lose trust; shared sub-graphs propagate to every
 * dependent, unrelated branches stay trusted.
 */
Store.prototype.reapplyDistrust = function (this: Store): { actionId: string; reason: string }[] {
  const corrections = this.db
    .prepare('SELECT * FROM corrections ORDER BY id')
    .all() as Record<string, unknown>[];
  const obs = loadAllObservations(this.db);

  const depMap = new Map<string, string[]>();
  for (const o of obs) {
    if (!depMap.has(o.actionId)) depMap.set(o.actionId, o.spec.deps);
  }
  const dependents = buildDependents(depMap);

  const tainted = new Map<string, string>();
  for (const c of corrections) {
    const rootAction = c.action_id as string;
    const reach = reachable([rootAction], dependents);
    const reason = `输入 ${c.input_path as string} 摘要纠正 (${String(c.bad_digest).slice(0, 8)} -> ${String(
      c.correct_digest,
    ).slice(0, 8)})`;
    for (const id of reach) {
      if (!tainted.has(id)) tainted.set(id, reason);
    }
  }

  this.db
    .prepare('UPDATE observations SET trusted=1, distrust_reason=NULL')
    .run();
  const mark = this.db.prepare('UPDATE observations SET trusted=0, distrust_reason=? WHERE action_id=?');
  for (const [id, reason] of tainted) mark.run(reason, id);

  return [...tainted.entries()].map(([actionId, reason]) => ({ actionId, reason }));
};

/**
 * Rebuild disputes for one rule version WITHOUT deleting existing rows.
 * First observation order is preserved; convergence only resolves (never
 * overwrites). Last-writer-wins is explicitly impossible here.
 */
Store.prototype.rebuildDisputes = function (this: Store, ruleVersionNumber: number): void {
  const rows = this.db
    .prepare(
      `SELECT * FROM observations
       WHERE rule_version=? AND status='success' AND trusted=1 AND key IS NOT NULL
       ORDER BY first_order`,
    )
    .all(ruleVersionNumber) as Record<string, unknown>[];

  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const list = byKey.get(r.key as string) ?? [];
    list.push(r);
    byKey.set(r.key as string, list);
  }

  const insert = this.db.prepare(
    `INSERT OR IGNORE INTO disputes
     (rule_version,key,first_result_version,second_result_version,first_action_id,second_action_id,
      first_output_hash,second_output_hash,first_observed_at,second_observed_at,
      first_manifest_id,second_manifest_id,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open')`,
  );

  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const distinctHashes: string[] = [];
    for (const m of members) {
      const h = m.output_set_hash as string;
      if (!distinctHashes.includes(h)) distinctHashes.push(h);
    }
    if (distinctHashes.length < 2) {
      // outputs converged: resolve open disputes, retain history
      this.db
        .prepare("UPDATE disputes SET status='resolved' WHERE rule_version=? AND key=? AND status='open'")
        .run(ruleVersionNumber, key);
      continue;
    }
    // first two sources in observation order define the dispute, forever
    const first = members.find((m) => (m.output_set_hash as string) === distinctHashes[0])!;
    const second = members.find((m) => (m.output_set_hash as string) === distinctHashes[1])!;
    insert.run(
      ruleVersionNumber as string | number | bigint | Uint8Array | null,
      key,
      first.result_version as number,
      second.result_version as number,
      first.action_id as string,
      second.action_id as string,
      first.output_set_hash as string,
      second.output_set_hash as string,
      first.observed_at as number,
      second.observed_at as number,
      first.manifest_id as string,
      second.manifest_id as string,
    );
  }
};

// ---------- queries ----------

Store.prototype.listActions = function (this: Store): ActionRow[] {
  const obsRows = this.db
    .prepare('SELECT * FROM observations ORDER BY first_order')
    .all() as Record<string, unknown>[];
  const byAction = new Map<string, ObsRow[]>();
  for (const r of obsRows) {
    const row: ObsRow = {
      actionId: r.action_id as string,
      resultVersion: r.result_version as number,
      manifestId: r.manifest_id as string,
      observedAt: r.observed_at as number,
      status: r.status as ObsRow['status'],
      key: (r.key as string | null) ?? null,
      ruleVersion: (r.rule_version as number | null) ?? null,
      outputSetHash: (r.output_set_hash as string) ?? null,
      trusted: Boolean(r.trusted),
      distrustReason: (r.distrust_reason as string | null) ?? null,
      spec: JSON.parse(r.spec_json as string) as ActionSpec,
      pinned: JSON.parse((r.pinned_json as string) ?? '[]') as ResolvedDep[],
      firstOrder: r.first_order as number,
    };
    const list = byAction.get(row.actionId) ?? [];
    list.push(row);
    byAction.set(row.actionId, list);
  }
  const actionRows = this.db.prepare('SELECT * FROM actions ORDER BY action_id').all() as Record<string, unknown>[];
  return actionRows.map((ar) => {
    const observations = byAction.get(ar.action_id as string) ?? [];
    const latest = observations[observations.length - 1];
    return {
      actionId: ar.action_id as string,
      command: latest?.spec.command ?? '',
      argv: latest?.spec.argv ?? [],
      cwd: latest?.spec.cwd ?? '',
      envWhitelist: latest?.spec.envWhitelist ?? [],
      deps: latest?.spec.deps ?? [],
      latestResultVersion: (ar.latest_result_version as number | null) ?? null,
      trusted: latest ? latest.trusted : true,
      distrustReason: latest ? latest.distrustReason : null,
      observations,
    };
  });
};

Store.prototype.getDag = function (
  this: Store,
): { nodes: { id: string; status: 'success' | 'failed'; trusted: boolean }[]; edges: { from: string; to: string }[] } {
  const actions = this.listActions();
  const nodes = actions.map((a) => ({
    id: a.actionId,
    status: a.observations[a.observations.length - 1]?.status ?? 'success',
    trusted: a.trusted,
  }));
  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const a of actions) {
    for (const dep of a.deps) {
      const k = `${a.actionId}->${dep}`;
      if (!seen.has(k)) {
        seen.add(k);
        edges.push({ from: a.actionId, to: dep });
      }
    }
  }
  return { nodes, edges };
};

Store.prototype.getFingerprint = function (
  this: Store,
  resultVersion: number,
  ruleVersionNumber?: number,
): Fingerprint {
  const row = this.db
    .prepare('SELECT * FROM observations WHERE result_version=?')
    .get(resultVersion) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`未知结果版本 ${resultVersion}`);
  const rv = ruleVersionNumber ?? this.getActiveRules().version;
  const rule = this.getRule(rv);
  const spec = JSON.parse(row.spec_json as string) as ActionSpec;
  const pinned = JSON.parse((row.pinned_json as string) ?? '[]') as ResolvedDep[];
  return fingerprint(spec, rule.rules, pinned, rv);
};

Store.prototype.compare = function (
  this: Store,
  versionA: number,
  versionB: number,
  ruleVersionNumber?: number,
): FingerprintComparison {
  const a = this.getFingerprint(versionA, ruleVersionNumber);
  const b = this.getFingerprint(versionB, ruleVersionNumber);
  return compareFingerprints(a, b);
};

Store.prototype.listDisputes = function (this: Store): DisputeRow[] {
  return (this.db.prepare('SELECT * FROM disputes ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    ruleVersion: r.rule_version as number,
    key: r.key as string,
    firstResultVersion: r.first_result_version as number,
    secondResultVersion: r.second_result_version as number,
    firstActionId: r.first_action_id as string,
    secondActionId: r.second_action_id as string,
    firstOutputHash: r.first_output_hash as string,
    secondOutputHash: r.second_output_hash as string,
    firstObservedAt: r.first_observed_at as number,
    secondObservedAt: r.second_observed_at as number,
    firstManifestId: r.first_manifest_id as string,
    secondManifestId: r.second_manifest_id as string,
    status: r.status as DisputeRow['status'],
    note: (r.note as string) ?? '',
  }));
};

Store.prototype.listCorrections = function (this: Store): CorrectionRow[] {
  return (this.db.prepare('SELECT * FROM corrections ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    actionId: r.action_id as string,
    inputPath: r.input_path as string,
    badDigest: r.bad_digest as string,
    correctDigest: r.correct_digest as string,
    createdAt: r.created_at as number,
    affectedActions: JSON.parse((r.affected_json as string) ?? '[]') as string[],
  }));
};

Store.prototype.listObservationsFlat = function (this: Store): ObservationRecord[] {
  return loadAllObservations(this.db)
    .filter((o) => o.status === 'success')
    .map((o) => ({
      actionId: o.actionId,
      resultVersion: o.resultVersion,
      spec: o.spec,
      pinned: o.pinned,
      trusted: o.trusted,
      outputSetHash: o.outputSetHash ?? '',
    }));
};

// ---------- corrections & dry runs ----------

Store.prototype.recordCorrection = function (
  this: Store,
  actionId: string,
  inputPath: string,
  badDigest: string,
  correctDigest: string,
): CorrectionRow {
  const obs = loadAllObservations(this.db);
  const match = obs.find((o) => o.actionId === actionId && o.spec.inputs.some((f) => f.path === inputPath));
  if (!match) throw new Error(`未找到动作 ${actionId} 的输入 ${inputPath}`);
  if (badDigest === correctDigest) throw new Error('纠正前后摘要相同');

  const ts = now();
  const info = this.db
    .prepare(
      `INSERT INTO corrections (action_id,input_path,bad_digest,correct_digest,created_at,affected_json)
       VALUES (?,?,?,?,?,'[]')`,
    )
    .run(actionId, inputPath, badDigest, correctDigest, ts);

  const tainted = this.reapplyDistrust();
  const affected = tainted.map((t) => t.actionId);
  this.db.prepare('UPDATE corrections SET affected_json=? WHERE id=?').run(JSON.stringify(affected), info.lastInsertRowid);

  const active = this.getActiveRules();
  this.rebuildDisputes(active.version);
  this.audit(
    'digest_corrected',
    `${actionId} 输入 ${inputPath} 摘要纠正；失信传播到 ${affected.length} 个动作`,
  );
  return {
    id: Number(info.lastInsertRowid),
    actionId,
    inputPath,
    badDigest,
    correctDigest,
    createdAt: ts,
    affectedActions: affected,
  };
};

Store.prototype.dryRunDraft = function (this: Store, draftVersion: number): DryRunResult {
  const draft = this.getRule(draftVersion);
  if (draft.status !== 'draft') throw new Error(`v${draftVersion} 不是草案`);
  const baseVersion = draft.parentVersion ?? 1;
  const base = this.getRule(baseVersion);
  const observations = this.listObservationsFlat();
  return coreDryRun(
    observations,
    { rules: base.rules, version: base.version },
    { rules: draft.rules, version: draft.version },
  );
};

Store.prototype.resetAll = function (this: Store): void {
  this.db.exec(`
    DELETE FROM audit_log;
    DELETE FROM import_chunks;
    DELETE FROM import_jobs;
    DELETE FROM disputes;
    DELETE FROM corrections;
    DELETE FROM observations;
    DELETE FROM actions;
    DELETE FROM manifests;
    DELETE FROM rule_versions;
    DELETE FROM sqlite_sequence;
  `);
  this.ensureBaseline();
};

export interface FullState {
  activeRuleVersion: number;
  rules: RuleVersion[];
  dag: ReturnType<Store['getDag']>;
  actions: ActionRow[];
  disputes: DisputeRow[];
  corrections: CorrectionRow[];
  jobs: ReturnType<Store['listJobs']>;
  audit: ReturnType<Store['listAudit']>;
}

Store.prototype.getState = function (this: Store): FullState {
  const active = this.getActiveRules();
  return {
    activeRuleVersion: active.version,
    rules: this.listRules(),
    dag: this.getDag(),
    actions: this.listActions(),
    disputes: this.listDisputes(),
    corrections: this.listCorrections(),
    jobs: this.listJobs(),
    audit: this.listAudit(),
  };
};

export interface Store {
  listRules(): RuleVersion[];
  getActiveRules(): RuleVersion;
  getRule(version: number): RuleVersion;
  createDraft(label: string, rules: NormalizationRule[], baseVersion?: number): RuleVersion;
  approveDraft(version: number): RuleVersion;
  rollbackRule(targetVersion: number): RuleVersion;
  audit(kind: string, detail: string): void;
  listAudit(): { id: number; at: number; kind: string; detail: string }[];

  startImport(
    jobId: string,
    totalChunks: number,
  ): { jobId: string; status: 'receiving'; totalChunks: number; receivedChunks: number };
  putChunk(jobId: string, chunkIndex: number, payloadJson: string): ImportChunkAck;
  finalizeImport(jobId: string): ImportChunkAck;
  listJobs(): { jobId: string; status: string; totalChunks: number; receivedChunks: number }[];

  rekeyAll(ruleVersion: number): void;
  deriveManifest(manifest: Manifest, contentHash: string, jobId: string): void;
  reapplyDistrust(): { actionId: string; reason: string }[];
  rebuildDisputes(ruleVersion: number): void;

  listActions(): ActionRow[];
  getDag(): {
    nodes: { id: string; status: 'success' | 'failed'; trusted: boolean }[];
    edges: { from: string; to: string }[];
  };
  getFingerprint(resultVersion: number, ruleVersion?: number): Fingerprint;
  compare(versionA: number, versionB: number, ruleVersion?: number): FingerprintComparison;
  listDisputes(): DisputeRow[];
  listCorrections(): CorrectionRow[];
  listObservationsFlat(): ObservationRecord[];

  recordCorrection(actionId: string, inputPath: string, badDigest: string, correctDigest: string): CorrectionRow;
  dryRunDraft(draftVersion: number): DryRunResult;
  resetAll(): void;
  getState(): FullState;
}

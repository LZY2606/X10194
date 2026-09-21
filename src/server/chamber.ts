// 指纹舱服务层：串联存储、规范化、指纹、DAG、失信传播、争议与规则版本。

import type { DatabaseSync } from 'node:sqlite';
import {
  beginManifest,
  completeManifest,
  insertActionAtomically,
  nextObservedSeq,
  openDatabase,
  pendingManifests,
} from './db';
import { buildGraph } from '../core/dag';
import { propagateDistrust } from '../core/distrust';
import {
  compareFingerprints,
  computeFingerprint,
  computeResultVersion,
  type DepResolution,
} from '../core/fingerprint';
import { canonicalEnv, defaultRules } from '../core/normalize';
import { runDryRun } from '../core/dryrun';
import type {
  CacheEntry,
  ChamberState,
  CompareResult,
  DagView,
  DigestCorrection,
  Dispute,
  DistrustPropagation,
  FileRecord,
  Fingerprint,
  ImportRecord,
  RawAction,
  RawManifest,
  RuleEvent,
  RuleSet,
  RuleVersion,
  UndeclaredEnv,
} from '../core/types';

interface StoredRow {
  manifest_id: string;
  seq: number;
  payload: string;
}

export class Chamber {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  // ---------- 原始清单导入（逐行动作原子提交，乱序也允许） ----------

  beginImport(manifestId: string, importedAt: string, total: number): void {
    beginManifest(this.db, manifestId, importedAt, total);
  }

  importAction(manifestId: string, seq: number, action: RawAction): void {
    insertActionAtomically(this.db, {
      manifestId,
      seq,
      payload: JSON.stringify(action),
    });
  }

  /** 乱序导入：动作可任意顺序到达，只要 manifestId 一致即可。 */
  importManifest(manifest: RawManifest): { actionCount: number } {
    beginManifest(this.db, manifest.manifestId, manifest.importedAt, manifest.actions.length);
    manifest.actions.forEach((action, idx) => {
      this.importAction(manifest.manifestId, idx, action);
    });
    completeManifest(this.db, manifest.manifestId);
    this.recomputeAll();
    return { actionCount: manifest.actions.length };
  }

  finishImport(manifestId: string): void {
    completeManifest(this.db, manifestId);
    this.recomputeAll();
  }

  recoveryStatus(): { manifestId: string; total: number; done: number }[] {
    return pendingManifests(this.db);
  }

  private loadRows(): { action: RawAction; manifestId: string; seq: number }[] {
    const rows = this.db
      .prepare('SELECT manifest_id, seq, payload FROM raw_actions ORDER BY manifest_id, seq')
      .all() as unknown as StoredRow[];
    return rows.map((r) => ({ manifestId: r.manifest_id, seq: r.seq, action: JSON.parse(r.payload) as RawAction }));
  }

  // ---------- 规则版本（草案 / 批准 / 回滚） ----------

  private ensureBootstrapRules(): number {
    const row = this.db.prepare('SELECT id FROM rule_versions ORDER BY id LIMIT 1').get() as
      | { id: number }
      | undefined;
    if (row) return row.id;
    const id = this.createDraft(defaultRules(), '初始规则版本（全部规范化关闭：只钉字节）');
    this.approveDraft(id, '初始版本默认生效');
    return id;
  }

  activeRuleVersion(): RuleVersion {
    const id = this.meta('active_rule_version');
    const row = this.db
      .prepare('SELECT * FROM rule_versions WHERE id = ?')
      .get(Number(id)) as unknown as RuleVersionRow;
    return toRuleVersion(row);
  }

  ruleVersions(): RuleVersion[] {
    const rows = this.db.prepare('SELECT * FROM rule_versions ORDER BY id').all() as unknown as RuleVersionRow[];
    return rows.map(toRuleVersion);
  }

  ruleEvents(): RuleEvent[] {
    return this.db
      .prepare('SELECT * FROM rule_events ORDER BY id')
      .all() as unknown as RuleEvent[];
  }

  createDraft(rules: RuleSet, note: string): number {
    const parent = this.metaOrNull('active_rule_version');
    const result = this.db
      .prepare(
        `INSERT INTO rule_versions (status, parent_version_id, rules_json, note, created_at, approved_at)
         VALUES ('draft', ?, ?, ?, ?, NULL)`,
      )
      .run(parent ? Number(parent) : null, JSON.stringify(rules), note, new Date().toISOString());
    const id = Number(result.lastInsertRowid);
    this.addEvent(id, 'created', `规则草案创建：${note}`);
    return id;
  }

  approveDraft(versionId: number, note = '批准生效'): void {
    const row = this.db.prepare('SELECT status FROM rule_versions WHERE id = ?').get(versionId) as
      | { status: string }
      | undefined;
    if (!row) throw new Error(`规则版本 ${versionId} 不存在`);
    if (row.status !== 'draft') throw new Error(`只能批准草案，当前状态 ${row.status}`);
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      tx.prepare("UPDATE rule_versions SET status = 'retired' WHERE status = 'active'").run();
      tx.prepare("UPDATE rule_versions SET status = 'active', approved_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        versionId,
      );
      tx.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_rule_version', ?)").run(
        String(versionId),
      );
      tx.exec('COMMIT');
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
    this.addEvent(versionId, 'approved', note);
    this.recomputeAll();
  }

  /** 回滚：以旧版本规则为父，生成一份新的活动版本；历史版本全部保留。 */
  rollbackTo(versionId: number, note = '回滚'): number {
    const target = this.db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(versionId) as
      | RuleVersionRow
      | undefined;
    if (!target) throw new Error(`规则版本 ${versionId} 不存在`);
    const rules = JSON.parse(target.rules_json) as RuleSet;
    const newId = this.createDraft(rules, `回滚到 v${versionId} 的规则集合：${note}`);
    this.approveDraft(newId, `回滚批准：复刻 v${versionId}`);
    this.addEvent(newId, 'rolled_back', `版本内容回滚自 v${versionId}`);
    return newId;
  }

  private addEvent(versionId: number, type: RuleEvent['type'], detail: string): void {
    this.db
      .prepare('INSERT INTO rule_events (version_id, type, at, detail) VALUES (?, ?, ?, ?)')
      .run(versionId, type, new Date().toISOString(), detail);
  }

  // ---------- 派生记录：指纹重算（规则切换 / 纠正后调用） ----------

  private correctionOverrides(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT path, new_digest FROM digest_corrections ORDER BY id')
      .all() as { path: string; new_digest: string }[];
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.path, row.new_digest); // 后纠正覆盖先纠正
    return map;
  }

  private distrustedActionSet(): { direct: Set<string>; all: Set<string> } {
    const direct = new Set<string>();
    const all = new Set<string>();
    const rows = this.db
      .prepare('SELECT action_id, direct FROM distrust_marks')
      .all() as { action_id: string; direct: number }[];
    for (const r of rows) {
      all.add(r.action_id);
      if (r.direct) direct.add(r.action_id);
    }
    return { direct, all };
  }

  recomputeAll(): void {
    this.ensureBootstrapRules();
    const active = this.activeRuleVersion();
    const rows = this.loadRows();
    const byId = new Map<string, { action: RawAction; manifestId: string }>();
    for (const row of rows) byId.set(row.action.id, { action: row.action, manifestId: row.manifestId });
    const overrides = this.correctionOverrides();
    const distrust = this.distrustedActionSet();

    const resolveDep = (id: string): DepResolution | null => {
      const dep = byId.get(id);
      if (!dep) return null;
      return {
        actionId: id,
        outputs: dep.action.outputs,
        failed: dep.action.failed ?? false,
        failureReason: dep.action.failureReason,
      };
    };

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM fingerprints WHERE rule_version_id = ?').run(active.id);
      const insert = this.db.prepare(
        `INSERT INTO fingerprints
          (action_id, manifest_id, rule_version_id, key, status, result_version,
           components_json, pins_json, distrusted, distrust_reason, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const fp = computeFingerprint({
          action: row.action,
          rules: active.rules,
          ruleVersionId: active.id,
          resolveDep,
          digestOverrides: overrides,
          correctedPaths: new Set<string>(),
        });
        const isDistrusted = distrust.all.has(row.action.id);
        const reason = isDistrusted
          ? distrust.direct.has(row.action.id)
            ? '直接输入命中错误摘要纠正，原指纹失信'
            : '上游可达动作失信，下游链结果不可信'
          : null;
        insert.run(
          row.action.id,
          row.manifestId,
          active.id,
          fp.key,
          fp.status,
          fp.resultVersion,
          JSON.stringify(fp.components),
          JSON.stringify(fp.dependencyPins),
          isDistrusted ? 1 : 0,
          reason,
          new Date().toISOString(),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private loadFingerprints(): Fingerprint[] {
    const rows = this.db
      .prepare('SELECT * FROM fingerprints ORDER BY action_id')
      .all() as unknown as FingerprintRow[];
    return rows.map((r) => ({
      actionId: r.action_id,
      ruleVersionId: r.rule_version_id,
      key: r.key,
      status: r.status,
      components: JSON.parse(r.components_json),
      dependencyPins: JSON.parse(r.pins_json),
      resultVersion: r.result_version,
      distrusted: r.distrusted === 1,
      distrustReason: r.distrust_reason,
    })) as Fingerprint[];
  }

  // ---------- 缓存观察：同 key 异输出 -> 争议（绝不覆盖） ----------

  observeCacheEntry(input: {
    actionId: string;
    manifestId: string;
    source: string;
    observedAt?: string;
    /** 远端缓存条目录下的输出摘要；与本动作产物不同即“命中旧文件”，进入争议 */
    remoteOutputs?: FileRecord[];
  }): { entry: CacheEntry; dispute: Dispute | null } {
    const fpRow = this.db
      .prepare(
        'SELECT * FROM fingerprints WHERE action_id = ? AND manifest_id = ? ORDER BY rule_version_id DESC LIMIT 1',
      )
      .get(input.actionId, input.manifestId) as unknown as FingerprintRow | undefined;
    if (!fpRow || !fpRow.key) throw new Error(`动作 ${input.actionId} 尚无可钉住的 key（依赖未解析）`);

    const actionRow = this.db
      .prepare('SELECT payload FROM raw_actions WHERE action_id = ? AND manifest_id = ?',)
      .get(input.actionId, input.manifestId) as { payload: string } | undefined;
    const action = JSON.parse(actionRow!.payload) as RawAction;
    const observedOutputs = input.remoteOutputs ?? action.outputs;
    const observedResultVersion = input.remoteOutputs
      ? computeResultVersion(input.remoteOutputs, this.activeRuleVersion().rules)
      : fpRow.result_version;

    const seq = nextObservedSeq(this.db);
    const observedAt = input.observedAt ?? new Date().toISOString();
    const entryResult = this.db
      .prepare(
        `INSERT INTO cache_entries
          (action_id, manifest_id, key, result_version, outputs_json, source, observed_seq, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actionId,
        input.manifestId,
        fpRow.key,
        observedResultVersion,
        JSON.stringify(observedOutputs),
        input.source,
        seq,
        observedAt,
      );
    const entryId = Number(entryResult.lastInsertRowid);

    // 检查同 key 下是否已有不同 resultVersion
    const siblings = this.db
      .prepare('SELECT result_version FROM cache_entries WHERE key = ? GROUP BY result_version')
      .all(fpRow.key) as { result_version: string }[];
    let dispute: Dispute | null = null;
    if (siblings.length > 1) {
      dispute = this.openDisputeIfNeeded(fpRow.key, entryId);
    }

    return {
      entry: {
        id: entryId,
        actionId: input.actionId,
        manifestId: input.manifestId,
        key: fpRow.key,
        resultVersion: observedResultVersion,
        outputs: observedOutputs,
        source: input.source,
        observedSeq: seq,
        observedAt,
      },
      dispute,
    };
  }

  private openDisputeIfNeeded(key: string, _triggerEntryId: number): Dispute {
    const existing = this.db.prepare('SELECT id FROM disputes WHERE key = ?').get(key) as
      | { id: number }
      | undefined;
    if (existing) return this.getDispute(existing.id)!;

    const entries = this.db
      .prepare('SELECT * FROM cache_entries WHERE key = ? ORDER BY observed_seq')
      .all(key) as unknown as CacheEntryRow[];
    const first = entries[0];
    const result = this.db
      .prepare(
        `INSERT INTO disputes (key, status, first_result_version, first_observed_seq, opened_at)
         VALUES (?, 'open', ?, ?, ?)`,
      )
      .run(key, first.result_version, first.observed_seq, new Date().toISOString());
    const disputeId = Number(result.lastInsertRowid);
    const link = this.db.prepare(
      'INSERT INTO dispute_entries (dispute_id, entry_id, ord) VALUES (?, ?, ?)',
    );
    entries.forEach((e, idx) => link.run(disputeId, e.id, idx));
    return this.getDispute(disputeId)!;
  }

  private getDispute(id: number): Dispute | null {
    const row = this.db.prepare('SELECT * FROM disputes WHERE id = ?').get(id) as unknown as DisputeRow | undefined;
    if (!row) return null;
    const links = this.db
      .prepare(
        `SELECT ce.*, de.ord FROM dispute_entries de
         JOIN cache_entries ce ON ce.id = de.entry_id
         WHERE de.dispute_id = ? ORDER BY de.ord`,
      )
      .all(id) as unknown as (CacheEntryRow & { ord: number })[];
    return {
      id: row.id,
      key: row.key,
      status: row.status as Dispute['status'],
      firstResultVersion: row.first_result_version,
      firstObservedSeq: row.first_observed_seq,
      openedAt: row.opened_at,
      entries: links.map((e) => ({
        entryId: e.id,
        actionId: e.action_id,
        manifestId: e.manifest_id,
        resultVersion: e.result_version,
        source: e.source,
        observedSeq: e.observed_seq,
        observedAt: e.observed_at,
        isFirst: e.observed_seq === row.first_observed_seq,
      })),
    };
  }

  disputes(): Dispute[] {
    const rows = this.db.prepare('SELECT id FROM disputes ORDER BY id').all() as { id: number }[];
    return rows.map((r) => this.getDispute(r.id)!).filter(Boolean);
  }

  cacheEntries(): CacheEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM cache_entries ORDER BY observed_seq')
      .all() as unknown as CacheEntryRow[];
    return rows.map((r) => ({
      id: r.id,
      actionId: r.action_id,
      manifestId: r.manifest_id,
      key: r.key,
      resultVersion: r.result_version,
      outputs: JSON.parse(r.outputs_json),
      source: r.source,
      observedSeq: r.observed_seq,
      observedAt: r.observed_at,
    }));
  }

  // ---------- 摘要纠错与失信传播 ----------

  correctDigest(input: {
    path: string;
    oldDigest: string;
    newDigest: string;
    note?: string;
  }): DistrustPropagation {
    const at = new Date().toISOString();
    const result = this.db
      .prepare(
        'INSERT INTO digest_corrections (path, old_digest, new_digest, at, note) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.path, input.oldDigest, input.newDigest, at, input.note ?? '');
    const correctionId = Number(result.lastInsertRowid);

    const rows = this.loadRows();
    const graphRows = rows.map((r) => ({ action: r.action, manifestId: r.manifestId }));
    const graph = buildGraph(graphRows);
    const byId = new Map(graphRows.map((r) => [r.action.id, r]));
    const prop = propagateDistrust(graph, input.path, input.oldDigest, byId);

    this.db.exec('BEGIN');
    try {
      const mark = this.db.prepare(
        `INSERT OR REPLACE INTO distrust_marks (correction_id, action_id, manifest_id, direct, paths_json)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const id of prop.directlyAffected) {
        const row = byId.get(id)!;
        mark.run(correctionId, id, row.manifestId, 1, JSON.stringify([[id]]));
      }
      for (const reach of prop.reachable) {
        const row = byId.get(reach.actionId)!;
        mark.run(correctionId, reach.actionId, row.manifestId, 0, JSON.stringify(reach.paths));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.recomputeAll();

    return {
      correctionId,
      path: input.path,
      oldDigest: input.oldDigest,
      newDigest: input.newDigest,
      at,
      note: input.note ?? '',
      directlyAffected: prop.directlyAffected,
      reachable: prop.reachable,
    };
  }

  corrections(): DigestCorrection[] {
    const rows = this.db
      .prepare('SELECT * FROM digest_corrections ORDER BY id')
      .all() as unknown as CorrectionRow[];
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      oldDigest: r.old_digest,
      newDigest: r.new_digest,
      at: r.at,
      note: r.note,
    }));
  }

  propagation(): DistrustPropagation[] {
    return this.corrections().map((c) => {
      const rows = this.db
        .prepare('SELECT action_id, direct, paths_json FROM distrust_marks WHERE correction_id = ?')
        .all(c.id) as { action_id: string; direct: number; paths_json: string }[];
      const directlyAffected = rows.filter((r) => r.direct === 1).map((r) => r.action_id).sort();
      const reachable = rows
        .filter((r) => r.direct === 0)
        .map((r) => ({ actionId: r.action_id, paths: JSON.parse(r.paths_json) as string[][] }))
        .sort((a, b) => (a.actionId < b.actionId ? -1 : 1));
      return { correctionId: c.id, path: c.path, oldDigest: c.oldDigest, newDigest: c.newDigest, at: c.at, note: c.note, directlyAffected, reachable };
    });
  }

  // ---------- 干跑 / 比较 / 状态 ----------

  dryRunDraft(draftVersionId: number) {
    const draft = this.db
      .prepare('SELECT * FROM rule_versions WHERE id = ?')
      .get(draftVersionId) as unknown as RuleVersionRow | undefined;
    if (!draft || draft.status !== 'draft') throw new Error(`v${draftVersionId} 不是草案`);
    const active = this.activeRuleVersion();
    const rows = this.loadRows();
    const byId = new Map(rows.map((r) => [r.action.id, r]));
    const fingerprints = this.loadFingerprintsByVersion(active.id);
    const fpByAction = new Map(fingerprints.map((f) => [f.actionId, f]));

    return runDryRun({
      actions: rows.map((r) => ({
        raw: r.action,
        manifestId: r.manifestId,
        baselineFp: fpByAction.get(r.action.id)!,
      })),
      baselineRules: active.rules,
      candidateRules: JSON.parse(draft.rules_json),
      baselineVersionId: active.id,
      candidateVersionId: draftVersionId,
      resolveDep: (id) => {
        const dep = byId.get(id);
        if (!dep) return null;
        return {
          actionId: id,
          outputs: dep.action.outputs,
          failed: dep.action.failed ?? false,
          failureReason: dep.action.failureReason,
        };
      },
    });
  }

  compare(actionA: string, actionB: string): CompareResult {
    const fps = this.loadFingerprints();
    const a = fps.find((f) => f.actionId === actionA);
    const b = fps.find((f) => f.actionId === actionB);
    if (!a || !b) throw new Error('找不到用于比较的动作指纹');
    const result = compareFingerprints(a, b);
    return {
      actionA,
      actionB,
      sameKey: result.sameKey,
      keyA: a.key,
      keyB: b.key,
      components: result.components,
      dependencyDiffs: result.dependencyDiffs,
    };
  }

  private loadFingerprintsByVersion(versionId: number): Fingerprint[] {
    const rows = this.db
      .prepare('SELECT * FROM fingerprints WHERE rule_version_id = ? ORDER BY action_id')
      .all(versionId) as unknown as FingerprintRow[];
    return rows.map((r) => ({
      actionId: r.action_id,
      ruleVersionId: r.rule_version_id,
      key: r.key,
      status: r.status,
      components: JSON.parse(r.components_json),
      dependencyPins: JSON.parse(r.pins_json),
      resultVersion: r.result_version,
      distrusted: r.distrusted === 1,
      distrustReason: r.distrust_reason,
    })) as Fingerprint[];
  }

  private undeclaredEnv(fps: Fingerprint[]): UndeclaredEnv[] {
    const active = this.activeRuleVersion();
    const rows = this.loadRows();
    const fpSet = new Map(fps.map((f) => [f.actionId, true]));
    const out: UndeclaredEnv[] = [];
    for (const row of rows) {
      if (!fpSet.has(row.action.id)) continue;
      const { undeclared } = canonicalEnv(row.action, active.rules, []);
      for (const key of undeclared) out.push({ actionId: row.action.id, key });
    }
    return out.sort((x, y) => (x.actionId === y.actionId ? (x.key < y.key ? -1 : 1) : x.actionId < y.actionId ? -1 : 1));
  }

  private dagView(): DagView {
    const rows = this.loadRows();
    const graph = buildGraph(rows);
    const fps = new Map(this.loadFingerprints().map((f) => [f.actionId, f]));
    const nodes = [...graph.actions.entries()].map(([id, row]) => {
      const fp = fps.get(id);
      const failed = row.action.failed ?? false;
      const unresolved = row.action.dependencies.some((d) => !graph.actions.has(d));
      return {
        id,
        manifestId: row.manifestId,
        status: failed ? ('failed' as const) : unresolved ? ('unresolved' as const) : ('succeeded' as const),
        distrusted: fp?.distrusted ?? false,
        key: fp?.key ?? null,
        ruleVersionId: fp?.ruleVersionId ?? null,
      };
    });
    const edges: DagView['edges'] = [];
    for (const [id, deps] of graph.depsOf) {
      for (const dep of deps) edges.push({ from: dep, to: id, dep, missing: !graph.actions.has(dep) });
    }
    return { nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)), edges, sharedDeps: [...graph.shared].sort() };
  }

  state(): ChamberState {
    this.ensureBootstrapRules();
    const rows = this.loadRows();
    const fps = this.loadFingerprints();
    const fpByAction = new Map(fps.map((f) => [f.actionId, f]));
    const active = this.metaOrNull('active_rule_version');

    const actions = rows.map((row) => {
      const fp = fpByAction.get(row.action.id);
      return {
        ...row.action,
        manifestId: row.manifestId,
        key: fp?.key ?? null,
        distrusted: fp?.distrusted ?? false,
        distrustReason: fp?.distrustReason ?? null,
        resultVersion: fp?.resultVersion ?? computeResultVersion(row.action.outputs, this.activeRuleVersion().rules),
        status: (fp?.status ?? 'missing_dependency') as Fingerprint['status'],
      };
    });

    const imports = (
      this.db
        .prepare('SELECT * FROM raw_manifests ORDER BY manifest_id')
        .all() as unknown as ManifestRow[]
    ).map((m) => ({
      manifestId: m.manifest_id,
      importedAt: m.imported_at,
      actionCount: m.total_actions,
      pending: m.pending === 1,
      importedActions: m.imported_actions,
    }));

    return {
      actions,
      fingerprints: fps,
      undeclaredEnv: this.undeclaredEnv(fps),
      ruleVersions: this.ruleVersions(),
      ruleEvents: this.ruleEvents(),
      activeRuleVersionId: active ? Number(active) : 0,
      cacheEntries: this.cacheEntries(),
      disputes: this.disputes(),
      corrections: this.corrections(),
      propagation: this.propagation(),
      imports,
      dag: this.dagView(),
    };
  }

  // ---------- 小工具 ----------

  private meta(key: string): string {
    const v = this.metaOrNull(key);
    if (v === null) throw new Error(`meta ${key} 缺失`);
    return v;
  }

  private metaOrNull(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }
}

interface RuleVersionRow {
  id: number;
  status: string;
  parent_version_id: number | null;
  rules_json: string;
  note: string;
  created_at: string;
  approved_at: string | null;
}
function toRuleVersion(row: RuleVersionRow): RuleVersion {
  return {
    id: row.id,
    status: row.status as RuleVersion['status'],
    parentVersionId: row.parent_version_id,
    rules: JSON.parse(row.rules_json),
    note: row.note,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

interface FingerprintRow {
  action_id: string;
  manifest_id: string;
  rule_version_id: number;
  key: string;
  status: string;
  result_version: string;
  components_json: string;
  pins_json: string;
  distrusted: number;
  distrust_reason: string | null;
}
interface CacheEntryRow {
  id: number;
  action_id: string;
  manifest_id: string;
  key: string;
  result_version: string;
  outputs_json: string;
  source: string;
  observed_seq: number;
  observed_at: string;
}
interface DisputeRow {
  id: number;
  key: string;
  status: string;
  first_result_version: string;
  first_observed_seq: number;
  opened_at: string;
}
interface CorrectionRow {
  id: number;
  path: string;
  old_digest: string;
  new_digest: string;
  at: string;
  note: string;
}
interface ManifestRow {
  manifest_id: string;
  imported_at: string;
  pending: number;
  total_actions: number;
  imported_actions: number;
}

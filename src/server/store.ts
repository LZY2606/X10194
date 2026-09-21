// 服务层：导入、派生、缓存观察、争议、失信传播、规则版本、干跑与比较。
import { getDb, logEvent, nextSeq } from "./db.ts";
import {
  BASELINE_RULE_ID,
  DEFAULT_RULE,
  captureEnv,
  cloneRule,
  computeResultHash,
  deriveKey,
  validateRule,
} from "../shared/rules.ts";
import { downstreamFrom, topoSort } from "../shared/topo.ts";
import type {
  ActionHealth,
  ActionNode,
  CacheEntry,
  CompareResult,
  DigestCorrection,
  Dispute,
  DistrustRow,
  ImportRow,
  DryRunResult,
  KeyDerivation,
  Manifest,
  RawAction,
  RuleSpec,
  RuleVersion,
} from "../shared/types.ts";

interface DbRuleVersion {
  id: number;
  spec_json: string;
  status: string;
  note: string;
  created_at: number;
  restores_version_id: number | null;
  superseded_by: number | null;
}

function nv(v: string | number | null | undefined): string | number | null {
  return v === undefined ? null : v;
}

function rowToRuleVersion(row: DbRuleVersion): RuleVersion {
  return {
    id: row.id,
    spec: JSON.parse(row.spec_json) as RuleSpec,
    status: row.status as RuleVersion["status"],
    note: row.note,
    createdAt: row.created_at,
    restoresVersionId: row.restores_version_id ?? undefined,
  };
}

export function listRuleVersions(): RuleVersion[] {
  return (
    getDb()
      .prepare("SELECT * FROM rule_versions ORDER BY id")
      .all() as unknown as DbRuleVersion[]
  ).map(rowToRuleVersion);
}

export function getRuleVersion(id: number): RuleVersion {
  const row = getDb()
    .prepare("SELECT * FROM rule_versions WHERE rule_versions.id = ?")
    .get(id) as DbRuleVersion | undefined;
  if (!row) throw new Error(`规则版本 ${id} 不存在`);
  return rowToRuleVersion(row);
}

export function currentRuleVersionId(): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(id), ?) AS id FROM rule_versions WHERE status = 'approved'")
    .get(BASELINE_RULE_ID) as { id: number };
  return row.id;
}

function upsertDerivation(
  ruleVersionId: number,
  importId: number,
  actionId: string,
  derivation: KeyDerivation,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO derivations
       (rule_version_id, import_id, action_id, action_key, result_hash,
        components_json, dep_pins_json, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rule_version_id, import_id, action_id) DO UPDATE SET
       action_key = excluded.action_key,
       result_hash = excluded.result_hash,
       components_json = excluded.components_json,
       dep_pins_json = excluded.dep_pins_json,
       warnings_json = excluded.warnings_json`,
  ).run(
    ruleVersionId,
    importId,
    actionId,
    derivation.key,
    derivation.resultHash,
    JSON.stringify(derivation.components),
    JSON.stringify(derivation.depPins),
    JSON.stringify(derivation.warnings),
  );
}

/** 对某次导入在指定规则版本下按拓扑序派生全部 key（含失败/共享子图处理） */
export function deriveImport(
  importId: number,
  ruleVersionId: number,
  opts: { persist?: boolean } = {},
): { derivations: Map<string, KeyDerivation>; invalid: Map<string, string>; order: string[] } {
  const persist = opts.persist ?? true;
  const db = getDb();
  const rule = getRuleVersion(ruleVersionId).spec;
  const actionRows = db
    .prepare(
      "SELECT action_id, raw_json FROM actions WHERE import_id = ? ORDER BY ordinal",
    )
    .all(importId) as { action_id: string; raw_json: string }[];
  const actions = actionRows.map((row) => JSON.parse(row.raw_json) as RawAction);
  const { order, invalid, byId } = topoSort(actions);
  const derivations = new Map<string, KeyDerivation>();
  const pinsByDep = new Map();

  for (const actionId of order) {
    const action = byId.get(actionId)!;
    const derivation = deriveKey(action, { rule, ruleVersionId, pinsByDep });
    derivations.set(actionId, derivation);
    // 失败节点照常派生（钉住失败结果），但永不产生可命中条目
    pinsByDep.set(actionId, {
      depId: actionId,
      depKey: derivation.key,
      resultHash: derivation.resultHash,
      status: action.result,
    });
    if (persist) upsertDerivation(ruleVersionId, importId, actionId, derivation);
  }
  return { derivations, invalid, order };
}

/** 批准新规则时，对所有已提交导入重新派生，并重放观察以建立新命名空间的条目 */
export function rederiveForRule(ruleVersionId: number): void {
  const db = getDb();
  const imports = db
    .prepare("SELECT id FROM imports WHERE status = 'committed' ORDER BY id")
    .all() as { id: number }[];
  for (const imp of imports) deriveImport(imp.id, ruleVersionId);
  // 以历史导入动作本身为来源，按导入顺序在新命名空间登记观察
  for (const imp of imports) {
    const derivations = db
      .prepare(
        `SELECT action_id, action_key, result_hash FROM derivations
         WHERE rule_version_id = ? AND import_id = ? ORDER BY action_id`,
      )
      .all(ruleVersionId, imp.id) as {
      action_id: string;
      action_key: string;
      result_hash: string;
    }[];
    const actionStatus = new Map(
      (
        db
          .prepare("SELECT action_id, raw_json FROM actions WHERE import_id = ?")
          .all(imp.id) as { action_id: string; raw_json: string }[]
      ).map((r) => [r.action_id, (JSON.parse(r.raw_json) as RawAction).result] as const),
    );
    for (const d of derivations) {
      if (actionStatus.get(d.action_id) === "failure") continue;
      observeEntry({
        key: d.action_key,
        ruleVersionId,
        resultHash: d.result_hash,
        source: `manifest#${imp.id}:${d.action_id}`,
        actionId: d.action_id,
        importId: imp.id,
        manual: false,
      });
    }
  }
}

export interface ImportResult {
  importId: number;
  manifestId: string;
  actionCount: number;
  invalid: { actionId: string; reason: string }[];
  failed: string[];
  rolledBack: boolean;
}

/** 导入清单：整批事务，动作允许乱序（前向引用） */
export function importManifest(
  manifest: Manifest,
  opts: { crashBeforeCommit?: boolean; autoObserve?: boolean } = {},
): ImportResult {
  const db = getDb();
  const now = Date.now();
  const info = db
    .prepare(
      "INSERT INTO imports (manifest_id, raw_json, status, imported_at) VALUES (?, ?, 'pending', ?)",
    )
    .run(manifest.manifestId, JSON.stringify(manifest), now);
  const importId = Number(info.lastInsertRowid);

  // 显式 SAVEPOINT 控制整批原子性，便于模拟提交前崩溃
  db.exec("SAVEPOINT import_sp");
  try {
    manifest.actions.forEach((action, ordinal) => {
      db.prepare(
        "INSERT INTO actions (import_id, action_id, ordinal, raw_json) VALUES (?, ?, ?, ?)",
      ).run(importId, action.id, ordinal, JSON.stringify(action));
    });

    const ruleId = currentRuleVersionId();
    const { invalid } = deriveImport(importId, ruleId, { persist: true });

    if (opts.crashBeforeCommit) {
      // 模拟进程崩溃：回滚保存点并保持 pending，不写 committed
      db.exec("ROLLBACK TO SAVEPOINT import_sp");
      db.exec("RELEASE SAVEPOINT import_sp");
      return {
        importId,
        manifestId: manifest.manifestId,
        actionCount: manifest.actions.length,
        invalid: [],
        failed: [],
        rolledBack: true,
      };
    }

    db.prepare(
      "UPDATE imports SET status = 'committed', committed_at = ? WHERE \"id\" = ?",
    ).run(Date.now(), importId);
    db.exec("RELEASE SAVEPOINT import_sp");
    logEvent(db, "import-committed", `import ${importId} manifest ${manifest.manifestId}`);

    if (opts.autoObserve ?? true) {
      observeImportActions(importId, ruleId);
    }

    return {
      importId,
      manifestId: manifest.manifestId,
      actionCount: manifest.actions.length,
      invalid: [...invalid.entries()].map(([actionId, reason]) => ({ actionId, reason })),
      failed: manifest.actions.filter((a) => a.result === "failure").map((a) => a.id),
      rolledBack: false,
    };
  } catch (err) {
    db.exec("ROLLBACK TO SAVEPOINT import_sp");
    db.exec("RELEASE SAVEPOINT import_sp");
    db.prepare("UPDATE imports SET status = 'rolled_back' WHERE \"id\" = ?").run(importId);
    throw err;
  }
}

/** 成功动作按导入顺序登记为缓存观察（失败动作不登记） */
export function observeImportActions(importId: number, ruleVersionId: number): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.action_id, d.action_key, d.result_hash, a.raw_json
       FROM derivations d JOIN actions a
         ON a.import_id = d.import_id AND a.action_id = d.action_id
       WHERE d.rule_version_id = ? AND d.import_id = ?
       ORDER BY a.ordinal`,
    )
    .all(ruleVersionId, importId) as {
    action_id: string;
    action_key: string;
    result_hash: string;
    raw_json: string;
  }[];
  for (const row of rows) {
    const action = JSON.parse(row.raw_json) as RawAction;
    if (action.result === "failure") continue;
    observeEntry({
      key: row.action_key,
      ruleVersionId,
      resultHash: row.result_hash,
      source: `manifest#${importId}:${row.action_id}`,
      actionId: row.action_id,
      importId,
      manual: false,
    });
  }
}

export interface ObserveInput {
  key: string;
  ruleVersionId: number;
  resultHash: string;
  source: string;
  actionId?: string;
  importId?: number;
  manual?: boolean;
}

/**
 * 登记一次缓存观察。同 key 不同输出 -> 争议：保留双方、按首次观察顺序，
 * 绝不覆盖。新观察总是追加（seq 单调），争议状态提升而不改写旧条目。
 */
export function observeEntry(input: ObserveInput): { entryId: number; disputeId?: number } {
  const db = getDb();
  const seq = Number(nextSeq(db));
  const params = [
    input.key,
    input.ruleVersionId,
    input.resultHash,
    input.source,
    nv(input.actionId),
    nv(input.importId),
    seq,
    Date.now(),
  ] as const;
  const info = db
    .prepare(
      `INSERT INTO cache_entries
         (action_key, rule_version_id, result_hash, source, action_id, import_id, seq, observed_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(...params);
  const entryId = Number(info.lastInsertRowid);

  const prior = db
    .prepare(
      `SELECT * FROM cache_entries
       WHERE rule_version_id = ? AND action_key = ? AND id < ? AND result_hash <> ?
       ORDER BY seq ASC`,
    )
    .get(input.ruleVersionId, input.key, entryId, input.resultHash) as
    | {
        id: number | bigint;
        result_hash: string;
        source: string;
      }
    | undefined;

  let disputeId: number | undefined;
  if (prior) {
    db.prepare("UPDATE cache_entries SET status = 'disputed' WHERE \"id\" = ?").run(prior.id);
    db.prepare("UPDATE cache_entries SET status = 'disputed' WHERE \"id\" = ?").run(entryId);
    const existing = db
      .prepare("SELECT id FROM disputes WHERE action_key = ? AND rule_version_id = ?")
      .get(input.key, input.ruleVersionId) as { id: number } | undefined;
    if (!existing) {
      const res = db.prepare(
        `INSERT INTO disputes
           (action_key, rule_version_id, first_entry_id, second_entry_id,
            first_source, second_source, first_result_hash, second_result_hash, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.key,
        input.ruleVersionId,
        Number(prior.id),
        entryId,
        prior.source,
        input.source,
        prior.result_hash,
        input.resultHash,
        Date.now(),
      );
      disputeId = Number(res.lastInsertRowid);
      logEvent(
        db,
        "dispute-opened",
        `key ${input.key.slice(0, 12)}… ${prior.source} vs ${input.source}`,
      );
    }
  }
  return { entryId, disputeId };
}

// ---------- 查询 ----------

export function listImports(): ImportRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.id, i.manifest_id, i.status, i.imported_at, i.committed_at,
              (SELECT COUNT(*) FROM actions a WHERE a.import_id = i.id) AS n
       FROM imports i ORDER BY i.id`,
    )
    .all() as {
    id: number;
    manifest_id: string;
    status: string;
    imported_at: number;
    committed_at: number | null;
    n: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    manifestId: r.manifest_id,
    status: r.status,
    importedAt: r.imported_at,
    committedAt: r.committed_at,
    actionCount: r.n,
  }));
}

export interface RecoveryLog {
  id: number;
  event: string;
  detail: string;
  at: number;
}

export function listRecoveryEvents(): RecoveryLog[] {
  return getDb()
    .prepare("SELECT id, event, detail, at FROM recovery_events ORDER BY id")
    .all() as unknown as RecoveryLog[];
}

function loadActionsByImport(): Map<number, Map<string, RawAction>> {
  const db = getDb();
  const rows = db
    .prepare("SELECT import_id, action_id, raw_json FROM actions ORDER BY import_id, ordinal")
    .all() as { import_id: number; action_id: string; raw_json: string }[];
  const result = new Map<number, Map<string, RawAction>>();
  for (const row of rows) {
    if (!result.has(row.import_id)) result.set(row.import_id, new Map());
    result.get(row.import_id)!.set(row.action_id, JSON.parse(row.raw_json) as RawAction);
  }
  return result;
}

export interface DistrustInfo {
  reason: string;
  rootActions: string[];
  correctionId: number;
}

function distrustIndex(): Map<string, DistrustInfo[]> {
  const db = getDb();
  const rows = db
    .prepare("SELECT import_id, action_id, reason, root_actions, correction_id FROM distrust")
    .all() as {
    import_id: number;
    action_id: string;
    reason: string;
    root_actions: string;
    correction_id: number;
  }[];
  const index = new Map<string, DistrustInfo[]>();
  for (const row of rows) {
    const key = `${row.import_id}:${row.action_id}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push({
      reason: row.reason,
      rootActions: JSON.parse(row.root_actions) as string[],
      correctionId: row.correction_id,
    });
  }
  return index;
}

export function listActions(ruleVersionId?: number): ActionNode[] {
  const ruleId = ruleVersionId ?? currentRuleVersionId();
  const db = getDb();
  const byImport = loadActionsByImport();
  const dist = distrustIndex();
  const nodes: ActionNode[] = [];
  for (const [importId, actions] of byImport) {
    const { invalid, byId } = topoSort([...actions.values()]);
    const derivRows = db
      .prepare(
        `SELECT action_id, action_key, result_hash FROM derivations
         WHERE import_id = ? AND rule_version_id = ?`,
      )
      .all(importId, ruleId) as { action_id: string; action_key: string; result_hash: string }[];
    const derivMap = new Map(derivRows.map((r) => [r.action_id, r]));
    for (const [actionId, action] of actions) {
      let health: ActionHealth = "ok";
      if (invalid.has(actionId)) health = "invalid";
      else if (action.result === "failure") health = "failed";
      else if (action.deps.some((dep) => byId.get(dep)?.result === "failure")) {
        health = "blocked";
      }
      const distrustRows = dist.get(`${importId}:${actionId}`);
      if (distrustRows) health = "distrusted";
      const deriv = derivMap.get(actionId);
      nodes.push({
        ...action,
        importId,
        health,
        key: deriv?.action_key,
        resultHash: deriv?.result_hash,
        distrustReasons: distrustRows?.map((d) => d.reason),
      });
    }
  }
  return nodes;
}

export function getDerivation(
  importId: number,
  actionId: string,
  ruleVersionId?: number,
): (KeyDerivation & { raw: RawAction; envCapture: ReturnType<typeof captureEnv> }) | null {
  const ruleId = ruleVersionId ?? currentRuleVersionId();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM derivations WHERE import_id = ? AND action_id = ? AND rule_version_id = ?`,
    )
    .get(importId, actionId, ruleId) as
    | {
        action_key: string;
        result_hash: string;
        components_json: string;
        dep_pins_json: string;
        warnings_json: string;
      }
    | undefined;
  const actionRow = db
    .prepare("SELECT raw_json FROM actions WHERE import_id = ? AND action_id = ?")
    .get(importId, actionId) as { raw_json: string } | undefined;
  if (!row || !actionRow) return null;
  const raw = JSON.parse(actionRow.raw_json) as RawAction;
  return {
    actionId,
    ruleVersionId: ruleId,
    key: row.action_key,
    resultHash: row.result_hash,
    components: JSON.parse(row.components_json),
    depPins: JSON.parse(row.dep_pins_json),
    warnings: JSON.parse(row.warnings_json),
    raw,
    envCapture: captureEnv(raw),
  };
}

// ---------- 缓存条目与争议 ----------

export function listEntries(ruleVersionId?: number): CacheEntry[] {
  const ruleId = ruleVersionId ?? currentRuleVersionId();
  return getDb()
    .prepare(
      `SELECT id, action_key AS key, rule_version_id AS ruleVersionId, result_hash AS resultHash,
              source, action_id AS actionId, import_id AS importId, seq,
              observed_at AS observedAt, status
       FROM cache_entries WHERE rule_version_id = ? ORDER BY seq`,
    )
    .all(ruleId) as unknown as CacheEntry[];
}

export function listDisputes(): Dispute[] {
  return getDb()
    .prepare(
      `SELECT id, action_key AS key, rule_version_id AS ruleVersionId,
              first_entry_id AS firstEntryId, second_entry_id AS secondEntryId,
              first_source AS firstSource, second_source AS secondSource,
              first_result_hash AS firstResultHash, second_result_hash AS secondResultHash,
              observed_at AS observedAt
       FROM disputes ORDER BY id`,
    )
    .all() as unknown as Dispute[];
}

// ---------- 摘要纠正与失信传播 ----------

export interface CorrectionResult {
  correctionId: number;
  path: string;
  rootActions: string[];
  distrustedActions: { actionId: string; importId: number; reason: string }[];
}

/**
 * 发现某输入摘要错误：原地更新原始清单以外的事实是不允许的，
 * 因此保留 raw_json 不动，记录 correction，并只让可达（依赖该输入）的动作失信。
 */
export function correctDigest(input: {
  importId: number;
  path: string;
  newDigest: string;
}): CorrectionResult {
  const db = getDb();
  const rows = db
    .prepare("SELECT action_id, raw_json FROM actions WHERE import_id = ? ORDER BY ordinal")
    .all(input.importId) as { action_id: string; raw_json: string }[];
  if (rows.length === 0) throw new Error(`导入 ${input.importId} 不存在`);
  const actions = rows.map((r) => JSON.parse(r.raw_json) as RawAction);
  const byId = new Map(actions.map((a) => [a.id, a]));

  const roots = actions.filter((a) =>
    a.inputs.some((f) => f.path === input.path),
  );
  if (roots.length === 0) throw new Error(`路径 ${input.path} 未出现在导入 ${input.importId} 的任何输入中`);

  const oldDigest = roots[0].inputs.find((f) => f.path === input.path)!.digest;
  if (oldDigest === input.newDigest) {
    throw new Error("新摘要与旧摘要相同，不构成纠正");
  }

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO corrections (import_id, path, old_digest, new_digest, corrected_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.importId, input.path, oldDigest, input.newDigest, now);
  const correctionId = Number(info.lastInsertRowid);

  // 共享子图：反向可达，只影响真正依赖该输入的动作
  const affected = downstreamFrom(new Set(roots.map((r) => r.id)), byId);
  const rootIds = roots.map((r) => r.id);
  const distrusted: CorrectionResult["distrustedActions"] = [];
  for (const actionId of affected) {
    const reason = `输入 ${input.path} 摘要由 ${oldDigest.slice(0, 10)}… 纠正为 ${input.newDigest.slice(0, 10)}…`;
    db.prepare(
      `INSERT OR IGNORE INTO distrust
         (action_id, import_id, reason, root_actions, correction_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(actionId, input.importId, reason, JSON.stringify(rootIds), correctionId, now);
    distrusted.push({ actionId, importId: input.importId, reason });
  }
  logEvent(
    db,
    "digest-corrected",
    `import ${input.importId} path ${input.path} -> ${affected.size} 个动作失信`,
  );
  return { correctionId, path: input.path, rootActions: rootIds, distrustedActions: distrusted };
}

export function listCorrections(): DigestCorrection[] {
  return getDb()
    .prepare(
      `SELECT id, import_id AS importId, path, old_digest AS oldDigest,
              new_digest AS newDigest, corrected_at AS correctedAt
       FROM corrections ORDER BY id`,
    )
    .all() as unknown as DigestCorrection[];
}

export function listDistrust(): DistrustRow[] {
  return getDb()
    .prepare(
      `SELECT id, action_id AS actionId, import_id AS importId, reason,
              root_actions AS rootActions, correction_id AS correctionId, created_at AS createdAt
       FROM distrust ORDER BY id`,
    )
    .all() as unknown as DistrustRow[];
}

/** 命中判定：key 命中但结果不同为争议命中；动作失信则为污染命中 */
export function lookupHit(actionId: string, importId: number, ruleVersionId?: number) {
  const ruleId = ruleVersionId ?? currentRuleVersionId();
  const db = getDb();
  const deriv = db
    .prepare(
      "SELECT action_key, result_hash FROM derivations WHERE import_id = ? AND action_id = ? AND rule_version_id = ?",
    )
    .get(importId, actionId, ruleId) as
    | { action_key: string; result_hash: string }
    | undefined;
  if (!deriv) return null;
  const entries = db
    .prepare(
      `SELECT * FROM cache_entries WHERE rule_version_id = ? AND action_key = ? ORDER BY seq`,
    )
    .all(ruleId, deriv.action_key) as unknown as {
      result_hash: string;
      status: string;
    }[];
  const distrust = db
    .prepare("SELECT reason FROM distrust WHERE import_id = ? AND action_id = ?")
    .all(importId, actionId) as { reason: string }[];
  return {
    key: deriv.action_key,
    resultHash: deriv.result_hash,
    entries,
    distrustReasons: distrust.map((d) => d.reason),
    verdict:
      distrust.length > 0
        ? "contaminated"
        : entries.length === 0
          ? "miss"
          : entries.some((e) => e.result_hash !== deriv.result_hash)
            ? "disputed-hit"
            : "true-hit",
  };
}

// ---------- 规则草案 / 批准 / 回滚 ----------

export function createDraft(spec: RuleSpec, note: string): RuleVersion {
  const errors = validateRule(spec);
  if (errors.length) throw new Error("规则草案不合法：" + errors.join("；"));
  const db = getDb();
  const info = db
    .prepare(
      "INSERT INTO rule_versions (spec_json, status, note, created_at) VALUES (?, 'draft', ?, ?)",
    )
    .run(JSON.stringify(spec), note, Date.now());
  return getRuleVersion(Number(info.lastInsertRowid));
}

/** 批准草案：冻结为新版本并在其命名空间重放全部历史动作 */
export function approveDraft(draftId: number): RuleVersion {
  const db = getDb();
  const draft = getRuleVersion(draftId);
  if (draft.status !== "draft") throw new Error(`版本 ${draftId} 不是草案`);
  const info = db
    .prepare(
      `INSERT INTO rule_versions (spec_json, status, note, created_at, restores_version_id)
       VALUES (?, 'approved', ?, ?, ?)`,
    ).run(JSON.stringify(draft.spec), `批准：${draft.note}`, Date.now(), draft.restoresVersionId ?? null);
  const approvedId = Number(info.lastInsertRowid);
  db.prepare("UPDATE rule_versions SET status = 'approved', superseded_by = ? WHERE \"id\" = ?").run(
    approvedId,
    draftId,
  );
  rederiveForRule(approvedId);
  logEvent(db, "rule-approved", `version ${approvedId} from draft ${draftId}`);
  return getRuleVersion(approvedId);
}

/**
 * 回滚：历史版本不可变。生成一个“恢复旧 spec”的新批准版本，
 * 保留完整版本谱系，然后在新命名空间重放。
 */
export function rollbackTo(versionId: number): RuleVersion {
  const db = getDb();
  const target = getRuleVersion(versionId);
  const info = db
    .prepare(
      `INSERT INTO rule_versions (spec_json, status, note, created_at, restores_version_id)
       VALUES (?, 'approved', ?, ?, ?)`,
    ).run(
      JSON.stringify(target.spec),
      `回滚：恢复版本 ${versionId} 的规则（${target.note}）`,
      Date.now(),
      versionId,
    );
  const newId = Number(info.lastInsertRowid);
  rederiveForRule(newId);
  logEvent(db, "rule-rollback", `version ${newId} restores ${versionId}`);
  return getRuleVersion(newId);
}

/** 干跑：不落地，用候选规则对全部历史动作重新派生，检查命中变化与碰撞反例 */
export function dryRun(candidate: RuleSpec, baseRuleVersionId?: number): DryRunResult {
  const baseId = baseRuleVersionId ?? currentRuleVersionId();
  const errors = validateRule(candidate);
  if (errors.length) throw new Error("候选规则不合法：" + errors.join("；"));
  const db = getDb();

  const imports = db
    .prepare("SELECT id FROM imports WHERE status = 'committed' ORDER BY id")
    .all() as { id: number }[];

  const derived: DryRunResult["derived"] = [];
  const byNewKey = new Map<string, { actionIds: string[]; resultHashes: Set<string> }>();
  const oldKeyOf = new Map<string, string>();

  for (const imp of imports) {
    const baseRows = db
      .prepare(
        "SELECT action_id, action_key FROM derivations WHERE import_id = ? AND rule_version_id = ?",
      )
      .all(imp.id, baseId) as { action_id: string; action_key: string }[];
    for (const row of baseRows) oldKeyOf.set(`${imp.id}:${row.action_id}`, row.action_key);

    const actionRows = db
      .prepare("SELECT action_id, raw_json FROM actions WHERE import_id = ? ORDER BY ordinal")
      .all(imp.id) as { action_id: string; raw_json: string }[];
    const actions = actionRows.map((r) => JSON.parse(r.raw_json) as RawAction);
    const { order, byId } = topoSort(actions);
    const pins = new Map();
    for (const actionId of order) {
      const action = byId.get(actionId)!;
      const d = deriveKey(action, { rule: candidate, ruleVersionId: baseId, pinsByDep: pins });
      pins.set(actionId, {
        depId: actionId,
        depKey: d.key,
        resultHash: d.resultHash,
        status: action.result,
      });
      const uid = `${imp.id}:${actionId}`;
      derived.push({ actionId: uid, oldKey: oldKeyOf.get(uid) ?? "", newKey: d.key });
      if (!byNewKey.has(d.key)) byNewKey.set(d.key, { actionIds: [], resultHashes: new Set() });
      const bucket = byNewKey.get(d.key)!;
      bucket.actionIds.push(uid);
      bucket.resultHashes.add(d.resultHash);
    }
  }

  const collisions: DryRunResult["collisions"] = [];
  const dangerousMerges: DryRunResult["dangerousMerges"] = [];
  for (const [key, bucket] of byNewKey) {
    if (bucket.actionIds.length > 1) {
      const resultHashes = [...bucket.resultHashes];
      collisions.push({ key, actionIds: bucket.actionIds, resultHashes });
      if (bucket.resultHashes.size > 1) {
        for (let i = 0; i < bucket.actionIds.length; i++) {
          for (let j = i + 1; j < bucket.actionIds.length; j++) {
            const a = bucket.actionIds[i];
            const b = bucket.actionIds[j];
            dangerousMerges.push({ a, b, key });
          }
        }
      }
    }
  }

  const newKeyToUids = new Map<string, string[]>();
  for (const d of derived) {
    if (!newKeyToUids.has(d.newKey)) newKeyToUids.set(d.newKey, []);
    newKeyToUids.get(d.newKey)!.push(d.actionId);
  }
  const merges: DryRunResult["merges"] = [];
  for (const [, uids] of newKeyToUids) {
    for (let i = 0; i < uids.length; i++) {
      for (let j = i + 1; j < uids.length; j++) {
        const a = uids[i];
        const b = uids[j];
        const oldKeysDiffer = oldKeyOf.get(a) !== oldKeyOf.get(b);
        if (oldKeysDiffer) merges.push({ a, b, oldKeysDiffer: true });
      }
    }
  }

  return {
    baseRuleVersionId: baseId,
    candidate: cloneRule(candidate),
    derived,
    collisions,
    merges,
    dangerousMerges,
  };
}

// ---------- 两次动作命中/未命中比较 ----------

export function compareActions(
  a: { importId: number; actionId: string },
  b: { importId: number; actionId: string },
  ruleVersionId?: number,
): CompareResult {
  const ruleId = ruleVersionId ?? currentRuleVersionId();
  const da = getDerivation(a.importId, a.actionId, ruleId);
  const db2 = getDerivation(b.importId, b.actionId, ruleId);
  if (!da || !db2) throw new Error("待比较的动作不存在");
  const componentDiffs: CompareResult["componentDiffs"] = [];
  let firstDiffering: string | undefined;
  for (let i = 0; i < da.components.length; i++) {
    const ca = da.components[i];
    const cb = db2.components[i];
    const equal = ca.bytes === cb.bytes;
    if (!equal && !firstDiffering) firstDiffering = ca.component;
    componentDiffs.push({ component: ca.component, equal, a: ca, b: cb });
  }
  const equalKey = da.key === db2.key;
  const equalResult = da.resultHash === db2.resultHash;
  const verdict: CompareResult["verdict"] = !equalKey
    ? "miss"
    : equalResult
      ? "true-hit"
      : "disputed-hit";
  return {
    a: `${a.importId}:${a.actionId}`,
    b: `${b.importId}:${b.actionId}`,
    ruleVersionId: ruleId,
    keyA: da.key,
    keyB: db2.key,
    resultHashA: da.resultHash,
    resultHashB: db2.resultHash,
    verdict,
    equalKey,
    equalResult,
    componentDiffs,
    firstDifferingComponent: firstDiffering,
    warnings: [...da.warnings, ...db2.warnings],
  };
}

void DEFAULT_RULE;

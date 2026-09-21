import type { Database as DB } from 'better-sqlite3';
import { computeAll, compareFingerprints } from '../core/fingerprint';
import { DEFAULT_RULE, cloneRule } from '../core/rules';
import { distrustedActionIds } from '../core/propagation';
import type {
  ActionManifest,
  Fingerprint,
  ImportBatch,
  RuleSpec,
} from '../core/types';
import { Repository } from './repository';

export interface DryRunResult {
  ruleVersion: number;
  changedKeys: Array<{
    actionId: string;
    oldKey: string;
    newKey: string;
    outputHash: string;
  }>;
  /** 新规则下同键异输出的碰撞反例（按输出哈希分组） */
  collisions: Array<{
    key: string;
    outputGroups: Array<{ outputHash: string; actionIds: string[] }>;
  }>;
  /** 规则改变后新产生的良性命中（同键同输出，原先不同键） */
  newBenignHits: Array<{ key: string; actionIds: string[]; outputHash: string }>;
  totalActions: number;
}

export class VaultService {
  repo: Repository;

  constructor(private db: DB) {
    this.repo = new Repository(db);
    this.ensureDefaultRule();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private ensureDefaultRule(): void {
    if (!this.repo.getMeta('active_rule_version')) {
      this.repo.insertRuleVersion(DEFAULT_RULE, '系统初始保守规则：不声明任何激进等价', this.now());
      this.repo.setMeta('active_rule_version', '0');
    }
  }

  // ---------- 规则 ----------
  activeRuleVersion(): number {
    return Number(this.repo.getMeta('active_rule_version') ?? '0');
  }

  activeRule(): RuleSpec {
    const versions = this.repo.listRuleVersions();
    const active = this.activeRuleVersion();
    return versions.find((v) => v.version === active)?.spec ?? DEFAULT_RULE;
  }

  listRuleVersions() {
    return this.repo.listRuleVersions();
  }

  listRuleEvents() {
    return this.repo.listRuleEvents();
  }

  getDraft(): RuleSpec {
    const raw = this.repo.getMeta('draft_rule');
    if (raw) return JSON.parse(raw) as RuleSpec;
    const base = cloneRule(this.activeRule());
    base.version = this.nextVersion();
    return base;
  }

  saveDraft(spec: RuleSpec): RuleSpec {
    const normalized = cloneRule(spec);
    normalized.version = this.nextVersion();
    this.repo.setMeta('draft_rule', JSON.stringify(normalized));
    return normalized;
  }

  private nextVersion(): number {
    const versions = this.repo.listRuleVersions().map((v) => v.version);
    return (versions.length ? Math.max(...versions) : 0) + 1;
  }

  approveDraft(note: string): { version: number } {
    const draft = this.getDraft();
    const at = this.now();
    const from = this.activeRuleVersion();
    this.repo.transaction(() => {
      this.repo.insertRuleVersion(draft, note || '批准草案', at);
      this.repo.setMeta('active_rule_version', String(draft.version));
      this.repo.addRuleEvent(at, 'approve', draft.version, from, note);
      this.rederiveLocked();
    });
    return { version: draft.version };
  }

  rollbackTo(version: number, note: string): void {
    const target = this.repo.listRuleVersions().find((v) => v.version === version);
    if (!target) throw new Error(`规则版本 ${version} 不存在，无法回滚`);
    const at = this.now();
    const from = this.activeRuleVersion();
    if (from === version) throw new Error(`当前已是规则 v${version}`);
    this.repo.transaction(() => {
      this.repo.setMeta('active_rule_version', String(version));
      this.repo.addRuleEvent(at, 'rollback', version, from, note || `回滚到 v${version}`);
      this.rederiveLocked();
    });
  }

  dryRun(draft: RuleSpec): DryRunResult {
    const actions = this.repo.loadActions();
    const overrides = this.digestOverrides();
    const current = computeAll(actions, this.activeRule(), overrides);
    const trial = computeAll(actions, draft, overrides);

    const changedKeys: DryRunResult['changedKeys'] = [];
    const byNewKey = new Map<string, Array<{ actionId: string; outputHash: string }>>();
    for (const [id, fp] of trial) {
      if (fp.status !== 'ok') continue;
      const old = current.get(id);
      if (old && old.key !== fp.key) {
        changedKeys.push({
          actionId: id,
          oldKey: old.key,
          newKey: fp.key,
          outputHash: fp.outputHash,
        });
      }
      const list = byNewKey.get(fp.key) ?? [];
      list.push({ actionId: id, outputHash: fp.outputHash });
      byNewKey.set(fp.key, list);
    }

    const collisions: DryRunResult['collisions'] = [];
    const newBenignHits: DryRunResult['newBenignHits'] = [];
    for (const [key, members] of byNewKey) {
      if (members.length < 2) continue;
      const groups = new Map<string, string[]>();
      for (const m of members) {
        const ids = groups.get(m.outputHash) ?? [];
        ids.push(m.actionId);
        groups.set(m.outputHash, ids);
      }
      if (groups.size > 1) {
        collisions.push({
          key,
          outputGroups: [...groups.entries()]
            .map(([outputHash, actionIds]) => ({ outputHash, actionIds: actionIds.sort() }))
            .sort((a, b) => a.outputHash.localeCompare(b.outputHash)),
        });
      } else {
        const outputHash = [...groups.keys()][0];
        const ids = members.map((m) => m.actionId).sort();
        // 只有旧规则下这些动作不同键，才算“新增命中”
        const oldKeys = new Set(ids.map((id) => current.get(id)?.key).filter(Boolean));
        if (oldKeys.size > 1) newBenignHits.push({ key, actionIds: ids, outputHash });
      }
    }

    return {
      ruleVersion: draft.version,
      changedKeys: changedKeys.sort((a, b) => a.actionId.localeCompare(b.actionId)),
      collisions: collisions.sort((a, b) => a.key.localeCompare(b.key)),
      newBenignHits: newBenignHits.sort((a, b) => a.key.localeCompare(b.key)),
      totalActions: actions.size,
    };
  }

  // ---------- 导入（原始不可变，允许乱序）----------
  importBatch(batch: ImportBatch): {
    batchId: string;
    inserted: number;
    skipped: string[];
    missingDeps: string[];
  } {
    if (this.repo.getBatch(batch.batchId)) {
      throw new Error(`批次 ${batch.batchId} 已存在（原始批次不可覆盖）`);
    }
    const ord = this.repo.listBatches().length + 1;
    const skipped: string[] = [];
    let inserted = 0;

    this.repo.transaction(() => {
      this.repo.insertBatch({
        batchId: batch.batchId,
        receivedAt: batch.receivedAt,
        rawJson: JSON.stringify(batch),
        ord,
      });
      for (const action of batch.actions) {
        if (this.repo.hasAction(action.id)) {
          skipped.push(action.id);
          continue;
        }
        this.repo.insertAction(action, batch.batchId, ord);
        for (const dep of action.deps) this.repo.insertEdge(action.id, dep, batch.batchId);
        inserted++;
      }
      this.rederiveLocked();
      this.repo.markBatchDerived(batch.batchId);
    });

    const fps = this.getState().fingerprints;
    const missingDeps = batch.actions
      .map((a) => a.id)
      .filter((id) => fps.get(id)?.status === 'missing-deps');
    return { batchId: batch.batchId, inserted, skipped, missingDeps };
  }

  /** 崩溃恢复：原始记录已落库但未完成派生的 pending 批次 */
  recoverPending(): { recovered: string[] } {
    const pending = this.repo.listPendingBatches();
    if (pending.length === 0) return { recovered: [] };
    this.repo.transaction(() => {
      this.rederiveLocked();
      for (const b of pending) this.repo.markBatchDerived(b.batch_id);
    });
    return { recovered: pending.map((b) => b.batch_id) };
  }

  // ---------- 派生重算（幂等）----------
  private digestOverrides(): Map<string, { algo: string; digest: string }> {
    const map = new Map<string, { algo: string; digest: string }>();
    for (const c of this.repo.listCorrections()) {
      map.set(c.path, { algo: c.newAlgo, digest: c.newDigest });
    }
    return map;
  }

  private rederiveLocked(): void {
    const actions = this.repo.loadActions();
    const fingerprints = computeAll(actions, this.activeRule(), this.digestOverrides());
    for (const fp of fingerprints.values()) this.repo.upsertFingerprint(fp);
    this.registerObservedEntries(actions, fingerprints);
  }

  /**
   * 观察条目只追加：同一动作首次成功派生即记录其 key/输出来源。
   * 同键异输出绝不覆盖，进入争议并保留首次观察顺序。
   */
  private registerObservedEntries(
    actions: Map<string, ActionManifest>,
    fingerprints: Map<string, Fingerprint>,
  ): void {
    for (const action of actions.values()) {
      const fp = fingerprints.get(action.id);
      if (!fp || fp.status !== 'ok') continue;
      if (this.repo.getCacheEntry(action.id)) continue;
      this.repo.insertCacheEntry({
        actionId: action.id,
        key: fp.key,
        outputHash: fp.outputHash,
        source: `remote-cache://ci-observer/${action.id}`,
        observedAt: this.observedAt(action.id),
      });
    }
    this.refreshDisputes();
  }

  private observedAt(actionId: string): string {
    const row = this.db
      .prepare(`SELECT b.received_at FROM actions a JOIN import_batches b ON a.batch_id=b.batch_id
               WHERE a.action_id=?`)
      .get(actionId) as { received_at: string } | undefined;
    return row?.received_at ?? this.now();
  }

  private refreshDisputes(): void {
    const byKey = new Map<string, Array<ReturnType<Repository['listCacheEntries']>[number]>>();
    for (const e of this.repo.listCacheEntries()) {
      const list = byKey.get(e.key) ?? [];
      list.push(e);
      byKey.set(e.key, list);
    }
    for (const [key, entries] of byKey) {
      const outputs = new Set(entries.map((e) => e.outputHash));
      if (outputs.size < 2) continue;
      const ordered = entries.sort((a, b) => a.id - b.id);
      let dispute = this.repo.getDisputeByKey(key);
      if (!dispute) {
        const id = this.repo.insertDispute(key, ordered[0].observedAt);
        dispute = { id, firstSeen: ordered[0].observedAt };
      }
      for (const e of ordered) {
        const parties = this.repo.listDisputes().find((d) => d.key === key)?.parties ?? [];
        if (parties.some((p) => p.actionId === e.actionId)) continue;
        this.repo.addDisputeParty(
          dispute.id,
          parties.length,
          e.actionId,
          e.outputHash,
          e.source,
          e.observedAt,
        );
      }
    }
  }

  // ---------- 摘要纠正：只使可达动作失信 ----------
  addCorrection(input: {
    path: string;
    newAlgo: string;
    newDigest: string;
    reason: string;
  }): { id: number; distrusted: string[] } {
    const actions = this.repo.loadActions();
    let old: { algo: string; digest: string } | undefined;
    for (const action of actions.values()) {
      const f = action.inputs.find((x) => x.path === input.path);
      if (f) {
        old = { algo: f.algo, digest: f.digest };
        break;
      }
    }
    if (!old) throw new Error(`没有任何动作声明输入 ${input.path}`);
    const createdAt = this.now();
    this.repo.transaction(() => {
      this.repo.addCorrection({
        path: input.path,
        oldAlgo: old!.algo,
        oldDigest: old!.digest,
        newAlgo: input.newAlgo,
        newDigest: input.newDigest,
        reason: input.reason,
        createdAt,
      });
      this.rederiveLocked();
    });
    const state = this.getState();
    return {
      id: this.repo.listCorrections().length,
      distrusted: [...(state.distrustedByCorrection[input.path] ?? [])],
    };
  }

  resolveDispute(key: string, note: string): void {
    this.repo.resolveDispute(key, note || '人工处理');
  }

  // ---------- 查询 ----------
  compare(leftId: string, rightId: string) {
    const left = this.repo.getFingerprint(leftId);
    const right = this.repo.getFingerprint(rightId);
    if (!left || !right) throw new Error('动作不存在或尚未完成派生');
    return compareFingerprints(left, right);
  }

  getState() {
    const actions = this.repo.loadActions();
    const fingerprints = new Map<string, Fingerprint>();
    for (const id of actions.keys()) {
      const fp = this.repo.getFingerprint(id);
      if (fp) fingerprints.set(id, fp);
    }
    const corrections = this.repo.listCorrections();
    const distrusted = distrustedActionIds(
      actions,
      corrections.map((c) => ({ path: c.path })),
    );
    const distrustedByCorrection: Record<string, string[]> = {};
    for (const c of corrections) {
      const reach = distrustedActionIds(actions, [{ path: c.path }]);
      distrustedByCorrection[c.path] = [...reach].sort();
    }

    return {
      batches: this.repo.listBatches(),
      actions,
      fingerprints,
      entries: this.repo.listCacheEntries(),
      disputes: this.repo.listDisputes(),
      corrections,
      distrusted: [...distrusted].sort(),
      distrustedByCorrection,
      activeRuleVersion: this.activeRuleVersion(),
      rules: this.repo.listRuleVersions(),
      ruleEvents: this.repo.listRuleEvents(),
    };
  }
}

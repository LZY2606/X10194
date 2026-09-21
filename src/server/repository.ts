import type { Database as DB } from 'better-sqlite3';
import type { ActionManifest, Fingerprint, RuleSpec } from '../core/types';

export interface BatchRow {
  batch_id: string;
  received_at: string;
  raw_json: string;
  status: 'pending' | 'derived';
  ord: number;
}

export class Repository {
  constructor(private db: DB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- meta / rules ----
  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  listRuleVersions(): Array<{ version: number; spec: RuleSpec; note: string; createdAt: string }> {
    const rows = this.db
      .prepare(`SELECT version, spec_json, note, created_at FROM rule_versions ORDER BY version`)
      .all() as Array<{ version: number; spec_json: string; note: string; created_at: string }>;
    return rows.map((r) => ({
      version: r.version,
      spec: JSON.parse(r.spec_json) as RuleSpec,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  insertRuleVersion(spec: RuleSpec, note: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO rule_versions(version, spec_json, note, created_at) VALUES (?,?,?,?)
         ON CONFLICT(version) DO NOTHING`,
      )
      .run(spec.version, JSON.stringify(spec), note, at);
  }

  listRuleEvents(): Array<{
    at: string;
    kind: string;
    fromVersion: number | null;
    toVersion: number;
    detail: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT at, kind, from_version, to_version, detail FROM rule_events ORDER BY id`,
      )
      .all() as Array<{
      at: string;
      kind: string;
      from_version: number | null;
      to_version: number;
      detail: string;
    }>;
    return rows.map((r) => ({
      at: r.at,
      kind: r.kind,
      fromVersion: r.from_version,
      toVersion: r.to_version,
      detail: r.detail,
    }));
  }

  addRuleEvent(
    at: string,
    kind: string,
    toVersion: number,
    fromVersion: number | null,
    detail: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO rule_events(at, kind, from_version, to_version, detail) VALUES (?,?,?,?,?)`,
)
      .run(at, kind, fromVersion, toVersion, detail);
  }

  // ---- batches / actions（原始不可变）----
  getBatch(batchId: string): BatchRow | undefined {
    return this.db
      .prepare(`SELECT * FROM import_batches WHERE batch_id=?`)
      .get(batchId) as BatchRow | undefined;
  }

  listBatches(): BatchRow[] {
    return this.db
      .prepare(`SELECT * FROM import_batches ORDER BY ord`)
      .all() as BatchRow[];
  }

  listPendingBatches(): BatchRow[] {
    return this.db
      .prepare(`SELECT * FROM import_batches WHERE status='pending' ORDER BY ord`)
      .all() as BatchRow[];
  }

  insertBatch(batch: {
    batchId: string;
    receivedAt: string;
    rawJson: string;
    ord: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO import_batches(batch_id, received_at, raw_json, status, ord)
         VALUES (?,?,?,'pending',?)`,
      )
      .run(batch.batchId, batch.receivedAt, batch.rawJson, batch.ord);
  }

  markBatchDerived(batchId: string): void {
    this.db.prepare(`UPDATE import_batches SET status='derived' WHERE batch_id=?`).run(batchId);
  }

  hasAction(actionId: string): boolean {
    return (
      (
        this.db.prepare(`SELECT 1 FROM actions WHERE action_id=?`).get(actionId) as
          | Record<string, unknown>
          | undefined
      ) !== undefined
    );
  }

  insertAction(action: ActionManifest, batchId: string, ord: number): void {
    this.db
      .prepare(
        `INSERT INTO actions(action_id, batch_id, raw_json, ord) VALUES (?,?,?,?)
         ON CONFLICT(action_id) DO NOTHING`,
      )
      .run(action.id, batchId, JSON.stringify(action), ord);
  }

  insertEdge(from: string, to: string, batchId: string): void {
    this.db
      .prepare(
        `INSERT INTO action_edges(from_action, to_action, batch_id) VALUES (?,?,?)
         ON CONFLICT(from_action, to_action) DO NOTHING`,
      )
      .run(from, to, batchId);
  }

  loadActions(): Map<string, ActionManifest> {
    const rows = this.db
      .prepare(`SELECT raw_json FROM actions ORDER BY ord, action_id`)
      .all() as Array<{ raw_json: string }>;
    const map = new Map<string, ActionManifest>();
    for (const row of rows) {
      const m = JSON.parse(row.raw_json) as ActionManifest;
      map.set(m.id, m);
    }
    return map;
  }

  // ---- 派生指纹（可重算）----
  upsertFingerprint(fp: Fingerprint): void {
    this.db
      .prepare(
        `INSERT INTO fingerprints(action_id, key, components_json, dep_pins_json, status,
            rule_version, output_hash, result_version, corrected_json)
         VALUES (@action_id,@key,@components_json,@dep_pins_json,@status,
            @rule_version,@output_hash,@result_version,@corrected_json)
         ON CONFLICT(action_id) DO UPDATE SET
            key=excluded.key, components_json=excluded.components_json,
            dep_pins_json=excluded.dep_pins_json, status=excluded.status,
            rule_version=excluded.rule_version, output_hash=excluded.output_hash,
            result_version=excluded.result_version, corrected_json=excluded.corrected_json`,
      )
      .run({
        action_id: fp.actionId,
        key: fp.key,
        components_json: JSON.stringify(fp.components),
        dep_pins_json: JSON.stringify(fp.depPins),
        status: fp.status,
        rule_version: fp.ruleVersion,
        output_hash: fp.outputHash,
        result_version: fp.resultVersion,
        corrected_json: JSON.stringify(fp.correctedInputPaths ?? []),
      });
  }

  getFingerprint(actionId: string): Fingerprint | undefined {
    const row = this.db.prepare(`SELECT * FROM fingerprints WHERE action_id=?`).get(actionId) as
      | {
          key: string;
          components_json: string;
          dep_pins_json: string;
          status: Fingerprint['status'];
          rule_version: number;
          output_hash: string;
          result_version: string;
          corrected_json: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      actionId,
      key: row.key,
      components: JSON.parse(row.components_json),
      depPins: JSON.parse(row.dep_pins_json),
      status: row.status,
      ruleVersion: row.rule_version,
      outputHash: row.output_hash,
      resultVersion: row.result_version,
      correctedInputPaths: JSON.parse(row.corrected_json),
    };
  }

  /** 已存在的观察条目（只追加） */
  getCacheEntry(actionId: string):
    | { key: string; outputHash: string; source: string; observedAt: string }
    | undefined {
    const row = this.db
      .prepare(`SELECT key, output_hash, source, observed_at FROM cache_entries WHERE action_id=?`)
      .get(actionId) as
      | { key: string; output_hash: string; source: string; observed_at: string }
      | undefined;
    if (!row) return undefined;
    return { key: row.key, outputHash: row.output_hash, source: row.source, observedAt: row.observed_at };
  }

  insertCacheEntry(e: {
    actionId: string;
    key: string;
    outputHash: string;
    source: string;
    observedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cache_entries(action_id, key, output_hash, source, observed_at)
         VALUES (?,?,?,?,?) ON CONFLICT(action_id) DO NOTHING`,
      )
      .run(e.actionId, e.key, e.outputHash, e.source, e.observedAt);
  }

  listCacheEntries(): Array<{
    id: number;
    actionId: string;
    key: string;
    outputHash: string;
    source: string;
    observedAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, action_id, key, output_hash, source, observed_at
         FROM cache_entries ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      action_id: string;
      key: string;
      output_hash: string;
      source: string;
      observed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      actionId: r.action_id,
      key: r.key,
      outputHash: r.output_hash,
      source: r.source,
      observedAt: r.observed_at,
    }));
  }

  // ---- 争议（只追加，不覆盖）----
  getDisputeByKey(key: string): { id: number; firstSeen: string } | undefined {
    const row = this.db.prepare(`SELECT id, first_seen FROM disputes WHERE key=?`).get(key) as
      | { id: number; first_seen: string }
      | undefined;
    return row ? { id: row.id, firstSeen: row.first_seen } : undefined;
  }

  insertDispute(key: string, firstSeen: string): number {
    this.db
      .prepare(`INSERT INTO disputes(key, status, first_seen) VALUES (?,'open',?)`)
      .run(key, firstSeen);
    return (this.db.prepare(`SELECT id FROM disputes WHERE key=?`).get(key) as { id: number }).id;
  }

  countDisputeParties(disputeId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM dispute_parties WHERE dispute_id=?`)
      .get(disputeId) as { n: number };
    return row.n;
  }

  addDisputeParty(
    disputeId: number,
    ord: number,
    actionId: string,
    outputHash: string,
    source: string,
    observedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dispute_parties(dispute_id, ord, action_id, output_hash, source, observed_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(dispute_id, ord) DO NOTHING`,
      )
      .run(disputeId, ord, actionId, outputHash, source, observedAt);
  }

  listDisputes(): Array<{
    id: number;
    key: string;
    status: string;
    resolutionNote: string | null;
    firstSeen: string;
    parties: Array<{
      ord: number;
      actionId: string;
      outputHash: string;
      source: string;
      observedAt: string;
    }>;
  }> {
    const ds = this.db
      .prepare(`SELECT id, key, status, resolution_note, first_seen FROM disputes ORDER BY id`)
      .all() as Array<{
      id: number;
      key: string;
      status: string;
      resolution_note: string | null;
      first_seen: string;
    }>;
    return ds.map((d) => {
      const parties = this.db
        .prepare(
          `SELECT ord, action_id, output_hash, source, observed_at
           FROM dispute_parties WHERE dispute_id=? ORDER BY ord`,
        )
        .all(d.id) as Array<{
        ord: number;
        action_id: string;
        output_hash: string;
        source: string;
        observed_at: string;
      }>;
      return {
        id: d.id,
        key: d.key,
        status: d.status,
        resolutionNote: d.resolution_note,
        firstSeen: d.first_seen,
        parties: parties.map((p) => ({
          ord: p.ord,
          actionId: p.action_id,
          outputHash: p.output_hash,
          source: p.source,
          observedAt: p.observed_at,
        })),
      };
    });
  }

  resolveDispute(key: string, note: string): void {
    this.db
      .prepare(`UPDATE disputes SET status='resolved', resolution_note=? WHERE key=?`)
      .run(note, key);
  }

  // ---- 摘要纠正 ----
  addCorrection(c: {
    path: string;
    oldAlgo: string;
    oldDigest: string;
    newAlgo: string;
    newDigest: string;
    reason: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO corrections(path, old_algo, old_digest, new_algo, new_digest, reason, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(c.path, c.oldAlgo, c.oldDigest, c.newAlgo, c.newDigest, c.reason, c.createdAt);
  }

  listCorrections(): Array<{
    id: number;
    path: string;
    oldAlgo: string;
    oldDigest: string;
    newAlgo: string;
    newDigest: string;
    reason: string;
    createdAt: string;
  }> {
    const rows = this.db.prepare(`SELECT * FROM corrections ORDER BY id`).all() as Array<{
      id: number;
      path: string;
      old_algo: string;
      old_digest: string;
      new_algo: string;
      new_digest: string;
      reason: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      oldDigest: r.old_digest,
      oldAlgo: r.old_algo,
      newAlgo: r.new_algo,
      newDigest: r.new_digest,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }
}

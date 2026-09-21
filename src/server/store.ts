import type { DatabaseSync } from "node:sqlite";
import { fingerprint } from "../domain/bytes.js";
import { computeAllFingerprints } from "../domain/canonical.js";
import type {
  ActionFingerprint,
  CacheEntryRecord,
  DisputeRecord,
  ManifestImport,
  RawAction,
  RawInput,
  RuleSet,
} from "../domain/types.js";

function nowIso() {
  return new Date().toISOString();
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function outputDigest(action: RawAction) {
  return fingerprint("outputs", (writer) => {
    writer.list(action.outputs, (outputWriter, output) => outputWriter.text(output.path).text(output.digest));
  });
}

function validateManifest(manifest: ManifestImport) {
  if (!manifest.id || !Array.isArray(manifest.actions)) throw new Error("清单缺少 id 或 actions");
  const ids = new Set<string>();
  for (const action of manifest.actions) {
    if (!action.id || !Array.isArray(action.argv) || !Array.isArray(action.inputs)) {
      throw new Error(`动作 ${action.id ?? "<unknown>"} 字段不完整`);
    }
    if (ids.has(action.id)) throw new Error(`重复动作: ${action.id}`);
    ids.add(action.id);
  }
  for (const action of manifest.actions) {
    for (const dependency of action.dependencies) {
      if (!ids.has(dependency)) throw new Error(`动作 ${action.id} 依赖不存在: ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(manifest.actions.map((action) => [action.id, action]));
  const walk = (id: string, trail: string[] = []) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`依赖成环: ${[...trail, id].join(" -> ")}`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) walk(dependency, [...trail, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const action of manifest.actions) walk(action.id);
}

function reverseReachability(actions: RawAction[], seedIds: Set<string>) {
  const dependents = new Map<string, string[]>();
  for (const action of actions) {
    for (const dependency of action.dependencies) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), action.id]);
    }
  }
  const reachable = new Set<string>();
  const queue = [...seedIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(dependents.get(id) ?? []));
  }
  return reachable;
}

export class VaultStore {
  constructor(private readonly db: DatabaseSync) {
    this.ensureInitialRules();
  }

  private ensureInitialRules() {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM rule_versions").get() as { count: number };
    if (Number(count.count) === 0) {
      const zero: RuleSet = { version: 0, status: "approved", rules: [], approvedAt: nowIso(), description: "初始严格规则" };
      this.db
        .prepare(
          "INSERT INTO rule_versions(version,status,rules,description,base_version,created_at,approved_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          0,
          "approved",
          JSON.stringify(zero.rules),
          zero.description ?? null,
          null,
          nowIso(),
          zero.approvedAt ?? null,
        );
    }
  }

  listRuleVersions(): RuleSet[] {
    return (this.db.prepare("SELECT * FROM rule_versions ORDER BY version DESC").all() as any[]).map((row) => ({
      version: row.version,
      status: row.status,
      rules: parse(row.rules),
      description: row.description ?? undefined,
      baseVersion: row.base_version ?? undefined,
      approvedAt: row.approved_at ?? undefined,
    }));
  }

  activeRuleSet(): RuleSet {
    const row = this.db
      .prepare("SELECT * FROM rule_versions WHERE status='approved' ORDER BY version DESC LIMIT 1")
      .get() as any;
    return {
      version: row.version,
      status: "approved",
      rules: parse(row.rules),
      description: row.description ?? undefined,
      baseVersion: row.base_version ?? undefined,
      approvedAt: row.approved_at ?? undefined,
    };
  }

  private getDraft(version: number): RuleSet {
    const row = this.db.prepare("SELECT * FROM rule_versions WHERE version=?").get(version) as any;
    if (!row) throw new Error(`规则版本不存在: ${version}`);
    return {
      version: row.version,
      status: row.status,
      rules: parse(row.rules),
      description: row.description ?? undefined,
      baseVersion: row.base_version ?? undefined,
      approvedAt: row.approved_at ?? undefined,
    };
  }

  createDraft(rules: RuleSet["rules"], description: string): RuleSet {
    const active = this.activeRuleSet();
    const nextRow = this.db.prepare("SELECT COALESCE(MAX(version), -1) + 1 AS version FROM rule_versions").get() as {
      version: number;
    };
    const version = Number(nextRow.version);
    this.db
      .prepare(
        "INSERT INTO rule_versions(version,status,rules,description,base_version,created_at,approved_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(version, "draft", JSON.stringify(rules), description, active.version, nowIso(), null);
    return this.getDraft(version);
  }

  importManifest(manifest: ManifestImport): { manifest: ManifestImport; fingerprints: ActionFingerprint[] } {
    validateManifest(manifest);
    const existing = this.db.prepare("SELECT id FROM manifests WHERE id=?").get(manifest.id);
    if (existing) throw new Error(`原始清单已存在且不可变: ${manifest.id}`);
    const active = this.activeRuleSet();
    const fingerprints = [...computeAllFingerprints(manifest.id, manifest.actions, active).values()];
    const createdAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO manifests(id,imported_at,payload) VALUES(?,?,?)")
        .run(manifest.id, manifest.importedAt, JSON.stringify(manifest));
      const insertAction = this.db.prepare(
        "INSERT INTO actions(manifest_id,action_id,payload) VALUES(?,?,?)",
      );
      for (const action of manifest.actions) insertAction.run(manifest.id, action.id, JSON.stringify(action));
      const insertKey = this.db.prepare(
        `INSERT INTO action_keys(manifest_id,action_id,rule_version,action_key,result_version,explanation,current,trusted,distrust_reasons,created_at)
         VALUES(?,?,?,?,?,?,1,1,'[]',?)`,
      );
      for (const fingerprintRecord of fingerprints) {
        insertKey.run(
          manifest.id,
          fingerprintRecord.actionId,
          fingerprintRecord.ruleVersion,
          fingerprintRecord.key,
          fingerprintRecord.resultVersion,
          JSON.stringify(fingerprintRecord),
          createdAt,
        );
      }
      this.db.exec("COMMIT");
      return { manifest, fingerprints };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private mapCacheEntry(row: any): CacheEntryRecord {
    return {
      id: Number(row.id),
      actionKey: String(row.action_key),
      resultVersion: String(row.result_version),
      outputDigest: String(row.output_digest),
      outputs: parse(row.outputs),
      source: String(row.source),
      observedAt: String(row.observed_at),
      observationOrder: Number(row.observation_order),
      state: row.state,
    };
  }

  private mapDispute(row: any): DisputeRecord {
    return {
      id: Number(row.id),
      actionKey: String(row.action_key),
      firstEntryId: Number(row.first_entry_id),
      conflictingEntryId: Number(row.conflicting_entry_id),
      firstOutputDigest: String(row.first_output_digest),
      conflictingOutputDigest: String(row.conflicting_output_digest),
      firstSource: String(row.first_source),
      conflictingSource: String(row.conflicting_source),
      firstObservedAt: String(row.first_observed_at),
      conflictingObservedAt: String(row.conflicting_observed_at),
      openedAt: String(row.opened_at),
    };
  }

  snapshot() {
    const manifestRows = this.db
      .prepare("SELECT id, imported_at, payload FROM manifests ORDER BY imported_at, id")
      .all() as any[];
    const actionRows = this.db
      .prepare(
        `SELECT ak.*, a.payload AS action_payload
         FROM action_keys ak
         JOIN actions a ON a.manifest_id=ak.manifest_id AND a.action_id=ak.action_id
         WHERE ak.current=1
         ORDER BY ak.manifest_id, ak.action_id, ak.generation DESC`,
      )
      .all() as any[];
    const cacheRows = this.db.prepare("SELECT * FROM cache_entries ORDER BY observation_order").all() as any[];
    const disputeRows = this.db.prepare("SELECT * FROM disputes ORDER BY id").all() as any[];
    const correctionRows = this.db.prepare("SELECT * FROM input_corrections ORDER BY id").all() as any[];
    const caches = cacheRows.map((row) => this.mapCacheEntry(row));

    const actions = actionRows.map((row) => {
      const action = parse<RawAction>(row.action_payload);
      const fingerprintRecord = parse<ActionFingerprint>(row.explanation);
      const exact = caches.find(
        (entry) =>
          entry.actionKey === row.action_key &&
          entry.resultVersion === row.result_version &&
          entry.state === "clean",
      );
      const disputed = caches.some((entry) => entry.actionKey === row.action_key && entry.state === "disputed");
      return {
        manifestId: row.manifest_id,
        action,
        fingerprint: fingerprintRecord,
        trusted: Boolean(row.trusted),
        distrustReasons: parse<string[]>(row.distrust_reasons),
        generation: Number(row.generation),
        cacheState: disputed ? "disputed" : exact ? "hit" : row.trusted ? "miss" : "distrusted",
        cacheEntryId: exact?.id ?? null,
      };
    });

    return {
      generatedAt: nowIso(),
      activeRules: this.activeRuleSet(),
      rules: this.listRuleVersions(),
      manifests: manifestRows.map((row) => {
        const payload = parse<ManifestImport>(row.payload);
        return { id: row.id, importedAt: row.imported_at, actionCount: payload.actions.length };
      }),
      graph: actions.map(({ manifestId, action }) => ({
        manifestId,
        id: action.id,
        dependencies: action.dependencies,
        status: action.status,
      })),
      actions,
      cache: caches,
      disputes: disputeRows.map((row) => this.mapDispute(row)),
      corrections: correctionRows.map((row) => ({
        id: Number(row.id),
        manifestId: row.manifest_id,
        inputId: row.input_id,
        oldDigest: row.old_digest,
        newDigest: row.new_digest,
        correctedAt: row.corrected_at,
      })),
    };
  }

  compareActions(leftManifest: string, leftAction: string, rightManifest: string, rightAction: string) {
    const get = (manifestId: string, actionId: string) => {
      const row = this.db
        .prepare(
          `SELECT explanation FROM action_keys
           WHERE manifest_id=? AND action_id=? AND current=1
           ORDER BY generation DESC LIMIT 1`,
        )
        .get(manifestId, actionId) as { explanation: string } | undefined;
      if (!row) throw new Error(`找不到动作: ${manifestId}/${actionId}`);
      return parse<ActionFingerprint>(row.explanation);
    };
    const left = get(leftManifest, leftAction);
    const right = get(rightManifest, rightAction);
    return {
      left,
      right,
      keyMatch: left.key === right.key,
      components: left.components.map((component, index) => ({
        component: component.component,
        match: component.digest === right.components[index]?.digest,
        left: component,
        right: right.components[index],
      })),
    };
  }
  private loadActions(manifestId: string): RawAction[] {
    const rows = this.db
      .prepare("SELECT payload FROM actions WHERE manifest_id=? ORDER BY action_id")
      .all(manifestId) as Array<{ payload: string }>;
    return rows.map((row) => parse<RawAction>(row.payload));
  }

  private loadManifest(manifestId: string): ManifestImport {
    const row = this.db.prepare("SELECT payload FROM manifests WHERE id=?").get(manifestId) as { payload: string };
    if (!row) throw new Error(`清单不存在: ${manifestId}`);
    return parse<ManifestImport>(row.payload);
  }

  private effectiveInputs(manifestId: string): Record<string, RawInput> {
    const rows = this.db
      .prepare(
        `SELECT input_id, new_digest FROM input_corrections
         WHERE id IN (SELECT MAX(id) FROM input_corrections WHERE manifest_id=? GROUP BY input_id)`,
      )
      .all(manifestId) as Array<{ input_id: string; new_digest: string }>;
    const result: Record<string, RawInput> = {};
    const manifest = this.loadManifest(manifestId);
    for (const action of manifest.actions) {
      for (const input of action.inputs) {
        const correction = rows.find((row) => row.input_id === input.id);
        if (correction) result[input.id] = { ...input, digest: correction.new_digest, digestWasCorrected: true };
      }
    }
    return result;
  }

  private replaceKeys(
    manifestId: string,
    ruleSet: RuleSet,
    distrusted: Set<string> = new Set(),
    generation = 0,
  ) {
    const actions = this.loadActions(manifestId);
    const effectiveInputs = this.effectiveInputs(manifestId);
    const fingerprints = computeAllFingerprints(manifestId, actions, ruleSet, effectiveInputs);
    const createdAt = nowIso();
    this.db
      .prepare("UPDATE action_keys SET current=0 WHERE manifest_id=? AND rule_version=? AND current=1")
      .run(manifestId, ruleSet.version);
    const insert = this.db.prepare(
      `INSERT INTO action_keys(manifest_id,action_id,rule_version,generation,action_key,result_version,explanation,current,trusted,distrust_reasons,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(manifest_id, action_id, rule_version, generation) DO UPDATE SET
         action_key=excluded.action_key,
         result_version=excluded.result_version,
         explanation=excluded.explanation,
         current=1,
         trusted=excluded.trusted,
         distrust_reasons=excluded.distrust_reasons,
         created_at=excluded.created_at`,
    );
    for (const fingerprintRecord of fingerprints.values()) {
      const reasons = distrusted.has(fingerprintRecord.actionId)
        ? ["该动作可达摘要曾被纠正；旧派生记录保留为失信证据"]
        : [];
      insert.run(
        manifestId,
        fingerprintRecord.actionId,
        ruleSet.version,
        generation,
        fingerprintRecord.key,
        fingerprintRecord.resultVersion,
        JSON.stringify({ ...fingerprintRecord, trusted: reasons.length === 0, distrustReasons: reasons }),
        1,
        reasons.length === 0 ? 1 : 0,
        JSON.stringify(reasons),
        createdAt,
      );
    }
  }

  approveDraft(version: number): RuleSet {
    const draft = this.getDraft(version);
    if (draft.status !== "draft") throw new Error("只能批准草案");
    const manifests = (this.db.prepare("SELECT id FROM manifests").all() as Array<{ id: string }>).map((row) => row.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE rule_versions SET status='rolledBack'
           WHERE status='approved' AND version<>?`,
        )
        .run(version);
      this.db.prepare("UPDATE rule_versions SET status='approved', approved_at=? WHERE version=?").run(nowIso(), version);
      for (const manifestId of manifests) this.replaceKeys(manifestId, draft, new Set(), this.latestGeneration(manifestId));
      this.db.exec("COMMIT");
      return this.getDraft(version);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private latestGeneration(manifestId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS generation FROM input_corrections WHERE manifest_id=?")
      .get(manifestId) as { generation: number };
    return Number(row.generation);
  }

  rollbackTo(version: number): RuleSet {
    const target = this.getDraft(version);
    if (target.status !== "approved" && target.status !== "rolledBack") {
      throw new Error("只能回滚到历史已批准版本");
    }
    const active = this.activeRuleSet();
    if (active.version === target.version) return target;
    const clone: RuleSet = { ...target, version: 0, status: "draft", baseVersion: active.version, description: `回滚到 v${version}` };
    const draft = this.createDraft(target.rules, clone.description!);
    return this.approveDraft(draft.version);
  }

  dryRun(version: number) {
    const candidate = this.getDraft(version);
    if (candidate.status !== "draft") throw new Error("只能干跑草案");
    const baseline = this.activeRuleSet();
    const manifests = (this.db.prepare("SELECT id FROM manifests ORDER BY imported_at, id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    type CandidateRow = {
      manifestId: string;
      actionId: string;
      status: RawAction["status"];
      outputDigest: string;
      oldKey: string;
      newKey: string;
      oldResult: string;
      newResult: string;
    };
    const rows: CandidateRow[] = [];
    for (const manifestId of manifests) {
      const actions = this.loadActions(manifestId);
      const effective = this.effectiveInputs(manifestId);
      const oldPrints = computeAllFingerprints(manifestId, actions, baseline, effective);
      const newPrints = computeAllFingerprints(manifestId, actions, candidate, effective);
      for (const action of actions) {
        const oldPrint = oldPrints.get(action.id)!;
        const newPrint = newPrints.get(action.id)!;
        rows.push({
          manifestId,
          actionId: action.id,
          status: action.status,
          outputDigest: outputDigest(action),
          oldKey: oldPrint.key,
          newKey: newPrint.key,
          oldResult: oldPrint.resultVersion,
          newResult: newPrint.resultVersion,
        });
      }
    }

    const groupBy = (key: keyof Pick<CandidateRow, "oldKey" | "newKey">) => {
      const groups = new Map<string, CandidateRow[]>();
      for (const row of rows) {
        groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
      }
      return [...groups.values()];
    };
    const summarize = (groups: CandidateRow[][], resultKey: "oldResult" | "newResult") => {
      const collisionGroups = groups
        .map((group) => {
          const byOutput = new Map<string, CandidateRow[]>();
          for (const row of group) {
            byOutput.set(row.outputDigest, [...(byOutput.get(row.outputDigest) ?? []), row]);
          }
          return byOutput.size > 1 && new Set(group.map((row) => row[resultKey])).size > 1 ? group : [];
        })
        .filter((group) => group.length > 1);
      return {
        compatibleGroups: groups.filter(
          (group) => new Set(group.map((row) => row[resultKey])).size === 1 && group.length > 1,
        ),
        collisionGroups,
      };
    };
    const oldGroups = groupBy("oldKey");
    const newGroups = groupBy("newKey");
    const oldSummary = summarize(oldGroups, "oldResult");
    const newSummary = summarize(newGroups, "newResult");
    return {
      draft: candidate,
      baseline,
      changedKeys: rows.filter((row) => row.oldKey !== row.newKey),
      oldCompatiblePairs: oldSummary.compatibleGroups,
      newCompatiblePairs: newSummary.compatibleGroups,
      oldCollisions: oldSummary.collisionGroups,
      newCollisions: newSummary.collisionGroups,
      collisionExamples: newSummary.collisionGroups.slice(0, 10),
    };
  }

  correctInput(manifestId: string, inputId: string, expectedOldDigest: string, newDigest: string) {
    const actions = this.loadActions(manifestId);
    const affectedInputs = actions.flatMap((action) => action.inputs).filter((input) => input.id === inputId);
    if (!affectedInputs.length) throw new Error(`输入不存在: ${inputId}`);
    const effective = this.effectiveInputs(manifestId);
    const currentDigest = effective[inputId]?.digest ?? affectedInputs[0]!.digest;
    if (currentDigest !== expectedOldDigest) throw new Error("旧摘要与当前事实不符，拒绝纠正");
    if (expectedOldDigest === newDigest) throw new Error("新旧摘要相同");

    const seeds = new Set(
      actions.filter((action) => action.inputs.some((input) => input.id === inputId)).map((action) => action.id),
    );
    const reachable = reverseReachability(actions, seeds);
    const active = this.activeRuleSet();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const correctionInfo = this.db
        .prepare(
          "INSERT INTO input_corrections(manifest_id,input_id,old_digest,new_digest,corrected_at) VALUES(?,?,?,?,?) RETURNING id",
        )
        .get(manifestId, inputId, expectedOldDigest, newDigest, nowIso()) as { id: number };
      const generation = Number(correctionInfo.id);
      const placeholders = [...reachable.keys()].map(() => "?").join(",");
      const oldKeys = this.db
        .prepare(
          `SELECT id, action_key FROM action_keys
           WHERE manifest_id=? AND rule_version=? AND current=1 AND action_id IN (${placeholders})`,
        )
        .all(manifestId, active.version, ...reachable) as Array<{ id: number; action_key: string }>;
      this.db
        .prepare(
          `UPDATE action_keys SET current=0, trusted=0, distrust_reasons=?
           WHERE manifest_id=? AND rule_version=? AND current=1 AND action_id IN (${placeholders})`,
        )
        .run(
          JSON.stringify(["输入摘要纠正：该派生 key 已失信"]),
          manifestId,
          active.version,
          ...reachable,
        );
      const keyList = [...new Set(oldKeys.map((row) => row.action_key))];
      if (keyList.length) {
        const keyPlaceholders = keyList.map(() => "?").join(",");
        this.db
          .prepare(
            `UPDATE cache_entries SET state='invalidated'
             WHERE state='clean' AND action_key IN (${keyPlaceholders})`,
          )
          .run(...keyList);
      }
      this.replaceKeys(manifestId, active, reachable, generation);
      this.db.exec("COMMIT");
      return { generation, reachable: [...reachable] };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  observeCache(entry: Omit<CacheEntryRecord, "id" | "observationOrder" | "state">): {
    entry: CacheEntryRecord;
    dispute?: DisputeRecord;
  } {
    const observedAt = entry.observedAt || nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const orderRow = this.db
        .prepare("SELECT COALESCE(MAX(observation_order), 0) + 1 AS ord FROM cache_entries")
        .get() as { ord: number };
      const order = Number(orderRow.ord);
      const info = this.db
        .prepare(
          `INSERT INTO cache_entries(action_key,result_version,output_digest,outputs,source,observed_at,observation_order,state)
           VALUES(?,?,?,?,?,?,?, 'clean') RETURNING id`,
        )
        .get(
          entry.actionKey,
          entry.resultVersion,
          entry.outputDigest,
          JSON.stringify(entry.outputs),
          entry.source,
          observedAt,
          order,
        ) as { id: number };
      const newEntryId = Number(info.id);
      const prior = this.db
        .prepare(
          `SELECT * FROM cache_entries
           WHERE action_key=? AND id<>? AND state IN ('clean','disputed')
           ORDER BY observation_order ASC`,
        )
        .all(entry.actionKey, newEntryId) as any[];
      let dispute: DisputeRecord | undefined;
      if (prior.some((row) => row.output_digest !== entry.outputDigest)) {
        const first = prior.find((row) => row.output_digest !== entry.outputDigest)!;
        this.db
          .prepare("UPDATE cache_entries SET state='disputed' WHERE action_key=? AND state IN ('clean','disputed')")
          .run(entry.actionKey);
        const disputeRow = this.db
          .prepare(
            `INSERT INTO disputes(
              action_key,first_entry_id,conflicting_entry_id,first_output_digest,conflicting_output_digest,
              first_source,conflicting_source,first_observed_at,conflicting_observed_at,opened_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *`,
          )
          .get(
            entry.actionKey,
            Number(first.id),
            newEntryId,
            String(first.output_digest),
            entry.outputDigest,
            String(first.source),
            entry.source,
            String(first.observed_at),
            observedAt,
            nowIso(),
          ) as any;
        dispute = this.mapDispute(disputeRow);
      }
      const row = this.db.prepare("SELECT * FROM cache_entries WHERE id=?").get(newEntryId) as any;
      this.db.exec("COMMIT");
      return { entry: this.mapCacheEntry(row), dispute };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

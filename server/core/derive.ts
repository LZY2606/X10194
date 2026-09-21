import { computeAllFingerprints, hashCanonical } from './engine.js';
import type {
  ActionManifest,
  CacheEntry,
  DigestCorrection,
  Dispute,
  Fingerprint,
  NormalizationRules,
  OutputFile,
} from './types.js';

export function outputsHash(outputs: OutputFile[]): string {
  const sorted = [...outputs].sort((a, b) => a.path.localeCompare(b.path));
  return hashCanonical(sorted);
}

export function computeDisputes(entries: (CacheEntry & { seq: number })[]): Dispute[] {
  const byKey = new Map<string, (CacheEntry & { seq: number })[]>();
  for (const e of entries) {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  }
  const disputes: Dispute[] = [];
  for (const [key, list] of byKey) {
    const distinct = new Set(list.map((e) => outputsHash(e.outputs)));
    if (distinct.size > 1) {
      const ordered = [...list].sort((a, b) => a.seq - b.seq);
      disputes.push({
        key,
        entries: ordered.map((e) => ({
          entryId: e.id,
          source: e.source,
          observedSeq: e.seq,
          outputs: e.outputs,
        })),
      });
    }
  }
  return disputes.sort((a, b) => a.key.localeCompare(b.key));
}

export function computeDistrust(
  actions: ActionManifest[],
  corrections: DigestCorrection[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (corrections.length === 0) return result;
  const byId = new Map(actions.map((a) => [a.id, a]));
  const dependents = new Map<string, string[]>();
  for (const a of actions) {
    for (const d of a.deps) {
      const list = dependents.get(d) ?? [];
      list.push(a.id);
      dependents.set(d, list);
    }
  }
  const queue: string[] = [];
  for (const a of actions) {
    for (const c of corrections) {
      const hit = a.inputs.find((i) => i.path === c.path && i.digest === c.oldDigest);
      if (hit && !result.has(a.id)) {
        result.set(a.id, `输入 ${c.path} 摘要被纠正: ${c.oldDigest} -> ${c.newDigest}`);
        queue.push(a.id);
      }
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dep of dependents.get(id) ?? []) {
      if (!result.has(dep)) {
        result.set(dep, `依赖 ${id} 失信,沿依赖图传播`);
        queue.push(dep);
      }
    }
  }
  void byId;
  return result;
}

export interface DryRunResult {
  newHits: { key: string; actionIds: string[] }[];
  splits: { beforeKey: string; groups: string[][] }[];
  collisions: { key: string; actionIds: string[]; outputsDistinct: number }[];
  changedKeys: { actionId: string; before: string; after: string }[];
}

function groupByKey(fps: Fingerprint[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const f of fps) {
    const list = m.get(f.key) ?? [];
    list.push(f.actionId);
    m.set(f.key, list);
  }
  return m;
}

export function dryRunRules(
  actions: ActionManifest[],
  currentRules: NormalizationRules,
  draftRules: NormalizationRules,
): DryRunResult {
  const before = computeAllFingerprints(actions, currentRules);
  const after = computeAllFingerprints(actions, draftRules);
  const beforeGroups = groupByKey(before);
  const afterGroups = groupByKey(after);

  const groupOf = (m: Map<string, string[]>, id: string) => {
    for (const [k, ids] of m) if (ids.includes(id)) return k;
    return undefined;
  };

  const newHits: DryRunResult['newHits'] = [];
  for (const [key, ids] of afterGroups) {
    if (ids.length < 2) continue;
    const beforeKeys = new Set(ids.map((id) => groupOf(beforeGroups, id)));
    if (beforeKeys.size > 1) newHits.push({ key, actionIds: ids.sort() });
  }

  const splits: DryRunResult['splits'] = [];
  for (const [key, ids] of beforeGroups) {
    if (ids.length < 2) continue;
    const afterKeys = new Set(ids.map((id) => groupOf(afterGroups, id)));
    if (afterKeys.size > 1) {
      const groups = new Map<string, string[]>();
      for (const id of ids) {
        const k = groupOf(afterGroups, id)!;
        const list = groups.get(k) ?? [];
        list.push(id);
        groups.set(k, list);
      }
      splits.push({ beforeKey: key, groups: [...groups.values()].map((g) => g.sort()) });
    }
  }

  const actionById = new Map(actions.map((a) => [a.id, a]));
  const collisions: DryRunResult['collisions'] = [];
  for (const [key, ids] of afterGroups) {
    if (ids.length < 2) continue;
    const distinct = new Set(ids.map((id) => outputsHash(actionById.get(id)!.outputs)));
    if (distinct.size > 1) {
      collisions.push({ key, actionIds: ids.sort(), outputsDistinct: distinct.size });
    }
  }

  const beforeKeyOf = new Map(before.map((f) => [f.actionId, f.key]));
  const changedKeys = after
    .filter((f) => beforeKeyOf.get(f.actionId) !== f.key)
    .map((f) => ({ actionId: f.actionId, before: beforeKeyOf.get(f.actionId)!, after: f.key }));

  return { newHits, splits, collisions, changedKeys };
}

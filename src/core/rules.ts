import { fingerprint } from './fingerprint';
import type {
  ActionSpec,
  DryRunResult,
  Fingerprint,
  NormalizationRule,
  ResolvedDep,
  RuleVersion,
} from './types';

/** v1: identity only. Nothing is assumed equivalent without declaration. */
export const BASELINE_RULE_VERSION: RuleVersion = {
  version: 1,
  label: 'v1 恒等基线',
  status: 'active',
  parentVersion: null,
  rules: [],
  createdAt: 0,
  approvedAt: 0,
};

export interface ObservationRecord {
  actionId: string;
  resultVersion: number;
  spec: ActionSpec;
  pinned: ResolvedDep[];
  trusted: boolean;
  outputSetHash: string;
}

export function computeKey(
  spec: ActionSpec,
  rules: NormalizationRule[],
  pinned: ResolvedDep[],
  ruleVersion: number,
): Fingerprint {
  return fingerprint(spec, rules, pinned, ruleVersion);
}

export interface KeyedObservation extends ObservationRecord {
  fp: Fingerprint;
}

export function keyAll(
  observations: ObservationRecord[],
  rules: NormalizationRule[],
  ruleVersion: number,
): KeyedObservation[] {
  return observations
    .filter((o) => o.spec.status === 'success')
    .map((o) => ({ ...o, fp: computeKey(o.spec, rules, o.pinned, ruleVersion) }));
}

/**
 * Dry-run a draft: report hit deltas against the baseline and expose
 * collision counter-examples (same key, different output sets).
 */
export function dryRun(
  observations: ObservationRecord[],
  baseline: { rules: NormalizationRule[]; version: number },
  draft: { rules: NormalizationRule[]; version: number },
): DryRunResult {
  const oldKeyed = keyAll(observations, baseline.rules, baseline.version);
  const newKeyed = keyAll(observations, draft.rules, draft.version);
  const oldById = new Map(oldKeyed.map((k) => [`${k.actionId}:${k.resultVersion}`, k]));

  const changes: DryRunResult['changes'] = [];
  let hitsGained = 0;
  let hitsLost = 0;
  let unchanged = 0;

  const oldGroups = groupByKey(oldKeyed);
  const newGroups = groupByKey(newKeyed);

  for (const n of newKeyed) {
    const id = `${n.actionId}:${n.resultVersion}`;
    const o = oldById.get(id);
    const oldKey = o?.fp.key ?? '';
    if (!o || oldKey === n.fp.key) {
      unchanged += 1;
    } else {
      changes.push({ actionId: n.actionId, oldKey, newKey: n.fp.key });
    }
  }

  // Hit gain: a new-key group merges observations whose old keys differed but
  // outputs agree. Hit loss: groups that used to agree on key split apart.
  for (const [key, members] of newGroups) {
    const outputs = new Set(members.map((m) => m.outputSetHash));
    if (members.length > 1 && outputs.size === 1) {
      const oldKeys = new Set(members.map((m) => oldById.get(`${m.actionId}:${m.resultVersion}`)?.fp.key));
      if (oldKeys.size > 1) hitsGained += members.length - 1;
    }
  }
  for (const [, members] of oldGroups) {
    const outputs = new Set(members.map((m) => m.outputSetHash));
    if (members.length > 1 && outputs.size === 1) {
      const newKeys = new Set(
        members.map((m) => newKeyed.find((n) => n.actionId === m.actionId && n.resultVersion === m.resultVersion)?.fp.key),
      );
      if (newKeys.size > 1) hitsLost += members.length - 1;
    }
  }

  const collisions: DryRunResult['collisions'] = [];
  for (const [key, members] of newGroups) {
    const outputs = new Set(members.map((m) => m.outputSetHash));
    if (members.length > 1 && outputs.size > 1) {
      const byHash = new Map<string, KeyedObservation>();
      for (const m of members) if (!byHash.has(m.outputSetHash)) byHash.set(m.outputSetHash, m);
      const [h1, h2] = [...byHash.values()];
      collisions.push({
        key,
        outputSetHashes: [...outputs],
        members: members.map((m) => ({ actionId: m.actionId, resultVersion: m.resultVersion })),
        counterexample: `${h1.actionId}#v${h1.resultVersion} 与 ${h2.actionId}#v${h2.resultVersion} 归一后同键，但输出集合 ${h1.outputSetHash.slice(0, 10)} != ${h2.outputSetHash.slice(0, 10)}`,
      });
    }
  }

  return {
    ruleVersion: draft.version,
    baselineVersion: baseline.version,
    observedActions: newKeyed.length,
    hitsGained,
    hitsLost,
    unchanged,
    changes,
    collisions,
  };
}

function groupByKey(items: KeyedObservation[]): Map<string, KeyedObservation[]> {
  const map = new Map<string, KeyedObservation[]>();
  for (const it of items) {
    const list = map.get(it.fp.key) ?? [];
    list.push(it);
    map.set(it.fp.key, list);
  }
  return map;
}

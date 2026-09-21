// 规则草案干跑：用历史动作在候选规则上重算 key，报告命中变化与碰撞反例。
// 碰撞反例分两类：同 key 异输出（真危险）、同 key 同输出（等价折叠，仅信息）。

import { computeFingerprint, computeResultVersion, type DepResolution } from './fingerprint';
import type {
  CollisionExample,
  DryRunDiff,
  DryRunResult,
  Fingerprint,
  RawAction,
  RuleSet,
} from './types';

export interface DryRunContext {
  actions: { raw: RawAction; manifestId: string; baselineFp: Fingerprint }[];
  baselineRules: RuleSet;
  candidateRules: RuleSet;
  baselineVersionId: number;
  candidateVersionId: number;
  resolveDep: (id: string) => DepResolution | null;
}

export function runDryRun(ctx: DryRunContext): DryRunResult {
  // 候选规则下依赖结果版本也会变化（如输出路径别名），因此按依赖顺序重算
  const candidateFps = new Map<string, Fingerprint>();
  const pending = new Set(ctx.actions.map((a) => a.raw.id));
  const byId = new Map(ctx.actions.map((a) => [a.raw.id, a.raw]));

  let guard = 0;
  while (pending.size > 0) {
    guard++;
    if (guard > ctx.actions.length + 5) break; // 环/缺失保护
    for (const id of [...pending]) {
      const action = byId.get(id)!;
      const ready = action.dependencies.every((d: string) => !byId.has(d) || candidateFps.has(d) || !pending.has(d));
      if (!ready) continue;
      const fp = computeFingerprint({
        action,
        rules: ctx.candidateRules,
        ruleVersionId: ctx.candidateVersionId,
        resolveDep: (depId) => {
          if (candidateFps.has(depId)) {
            const depAction = byId.get(depId);
            return {
              actionId: depId,
              outputs: depAction?.outputs ?? [],
              failed: depAction?.failed ?? false,
              failureReason: depAction?.failureReason,
            };
          }
          return ctx.resolveDep(depId);
        },
      });
      candidateFps.set(id, fp);
      pending.delete(id);
    }
  }

  const diffs: DryRunDiff[] = [];
  for (const actionRow of ctx.actions) {
    const action = actionRow.raw;
    const baselineFp = actionRow.baselineFp;
    const candidateFp = candidateFps.get(action.id);
    if (!candidateFp) continue;
    const changes: DryRunDiff['changes'] = [];
    const names = new Set<string>();
    baselineFp.components.forEach((c) => names.add(c.name));
    candidateFp.components.forEach((c) => names.add(c.name));
    for (const name of names) {
      const a = baselineFp.components.find((c) => c.name === name);
      const b = candidateFp.components.find((c) => c.name === name);
      if ((a?.hash ?? '') !== (b?.hash ?? '')) {
        changes.push({ component: name, baselineHash: a?.hash ?? '', candidateHash: b?.hash ?? '' });
      }
    }
    diffs.push({
      actionId: action.id,
      baselineKey: baselineFp.key,
      candidateKey: candidateFp.key,
      changed: baselineFp.key !== candidateFp.key,
      changes,
    });
  }

  // 碰撞：候选 key 相同的动作分组
  const groups = new Map<string, { actionId: string; resultVersion: string }[]>();
  for (const actionRow of ctx.actions) {
    const action = actionRow.raw;
    const fp = candidateFps.get(action.id)!;
    if (!fp.key) continue;
    const resultVersion = computeResultVersion(action.outputs, ctx.candidateRules);
    const list = groups.get(fp.key) ?? [];
    list.push({ actionId: action.id, resultVersion });
    groups.set(fp.key, list);
  }

  const collisions: CollisionExample[] = [];
  const missingOutputCollisions: CollisionExample[] = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const distinctResults = new Set(members.map((m) => m.resultVersion));
    const example: CollisionExample = {
      key,
      actionIds: members.map((m) => m.actionId),
      resultVersions: members.map((m) => m.resultVersion),
      sameOutputs: distinctResults.size === 1,
    };
    (distinctResults.size === 1 ? missingOutputCollisions : collisions).push(example);
  }

  return {
    draftVersionId: ctx.candidateVersionId,
    diffs: diffs.sort((a, b) => (a.actionId < b.actionId ? -1 : 1)),
    changedCount: diffs.filter((d) => d.changed).length,
    collisions,
    missingOutputCollisions,
  };
}

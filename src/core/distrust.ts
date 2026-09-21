// 失信传播：某输入摘要被发现错误时，只有“消费了该文件”的动作及其下游可达动作失信。
// 不相关分支（即使在同一次导入里）保持可信。

import { reachableWithPaths, type ActionGraph } from './dag';
import type { RawAction } from './types';

export interface DistrustResult {
  directlyAffected: string[];
  reachable: { actionId: string; paths: string[][] }[];
  allAffected: Set<string>;
}

export function propagateDistrust(
  graph: ActionGraph,
  path: string,
  oldDigest: string,
  actionsById: Map<string, { action: RawAction; manifestId: string }>,
): DistrustResult {
  const directlyAffected: string[] = [];
  for (const [id, row] of actionsById) {
    const hit = row.action.inputs.some((f) => f.path === path && f.digest === oldDigest);
    if (hit) directlyAffected.push(id);
  }
  const reachMap = reachableWithPaths(graph, directlyAffected);
  const allAffected = new Set<string>(directlyAffected);
  const reachable = [...reachMap.entries()]
    .map(([actionId, paths]) => ({ actionId, paths }))
    .sort((a, b) => (a.actionId < b.actionId ? -1 : 1));
  for (const { actionId } of reachable) allAffected.add(actionId);
  return { directlyAffected: directlyAffected.sort(), reachable, allAffected };
}

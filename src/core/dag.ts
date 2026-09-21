// 动作 DAG：共享子图识别、可达性（失信传播）、分层渲染辅助。

import type { RawAction } from './types';

export interface ActionGraph {
  /** actionId -> 原始动作（含 manifestId） */
  actions: Map<string, { action: RawAction; manifestId: string }>;
  /** actionId -> 其依赖 id */
  depsOf: Map<string, string[]>;
  /** actionId -> 反向依赖（谁依赖它） */
  dependentsOf: Map<string, string[]>;
  /** 被 >=2 个动作依赖的共享节点 */
  shared: Set<string>;
}

export function buildGraph(rows: { action: RawAction; manifestId: string }[]): ActionGraph {
  const actions = new Map<string, { action: RawAction; manifestId: string }>();
  for (const row of rows) actions.set(row.action.id, row);
  const depsOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const id of actions.keys()) {
    depsOf.set(id, []);
    dependentsOf.set(id, []);
  }
  for (const row of rows) {
    depsOf.set(row.action.id, [...row.action.dependencies]);
    for (const dep of row.action.dependencies) {
      if (!dependentsOf.has(dep)) dependentsOf.set(dep, []);
      dependentsOf.get(dep)!.push(row.action.id);
    }
  }
  const shared = new Set<string>();
  for (const [id, dependents] of dependentsOf) {
    if (new Set(dependents).size >= 2) shared.add(id);
  }
  return { actions, depsOf, dependentsOf, shared };
}

/** 从一组起点沿反向依赖边求可达节点（即“消费了这些输入的下游动作”），并给出路径。 */
export function reachableWithPaths(
  graph: ActionGraph,
  starts: string[],
): Map<string, string[][]> {
  const result = new Map<string, string[][]>();
  const queue: { id: string; path: string[] }[] = starts.map((s) => ({ id: s, path: [s] }));
  const seen = new Set<string>();
  while (queue.length) {
    const { id, path } = queue.shift()!;
    for (const dependent of graph.dependentsOf.get(id) ?? []) {
      const nextPath = [...path, dependent];
      const existing = result.get(dependent) ?? [];
      if (existing.length < 8) result.set(dependent, [...existing, nextPath]);
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push({ id: dependent, path: nextPath });
      }
    }
  }
  return result;
}

/** 拓扑分层（最长路径），供 UI 画 DAG；返回每层节点 id。 */
export function layeredOrder(graph: ActionGraph): string[][] {
  const indegree = new Map<string, number>();
  for (const id of graph.actions.keys()) indegree.set(id, 0);
  for (const [, deps] of graph.depsOf) {
    for (const dep of deps) {
      if (graph.actions.has(dep)) indegree.set(dep, indegree.get(dep)!);
    }
  }
  // 层：0 = 无依赖；边从依赖指向消费者
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visiting.has(id)) return 0; // 环保护
    visiting.add(id);
    let layer = 0;
    for (const dep of graph.depsOf.get(id) ?? []) {
      if (graph.actions.has(dep)) layer = Math.max(layer, resolve(dep) + 1);
    }
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  for (const id of graph.actions.keys()) resolve(id);
  const layers: string[][] = [];
  for (const [id, layer] of layerOf) {
    (layers[layer] ??= []).push(id);
  }
  return layers.filter((l) => l).map((l) => l.sort());
}

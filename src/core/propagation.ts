import type { ActionManifest } from './types';

/**
 * 某输入摘要被发现错误时，只使“可达”动作失信：
 * 从所有直接读取该路径的动作出发，沿依赖边反向 BFS。
 * 共享子图的多个下游都会被覆盖，无关节点不受影响。
 */
export function reachableFrom(
  actions: Map<string, ActionManifest>,
  correctedPaths: Set<string>,
): Set<string> {
  const roots = new Set<string>();
  for (const action of actions.values()) {
    if (action.inputs.some((f) => correctedPaths.has(f.path))) roots.add(action.id);
  }

  const reverse = new Map<string, string[]>();
  for (const action of actions.values()) {
    for (const dep of action.deps) {
      const list = reverse.get(dep) ?? [];
      list.push(action.id);
      reverse.set(dep, list);
    }
  }

  const reached = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const downstream of reverse.get(id) ?? []) {
      if (!reached.has(downstream)) {
        reached.add(downstream);
        queue.push(downstream);
      }
    }
  }
  return reached;
}

/** 汇总所有纠正记录影响到的动作 */
export function distrustedActionIds(
  actions: Map<string, ActionManifest>,
  corrections: Array<{ path: string }>,
): Set<string> {
  return reachableFrom(actions, new Set(corrections.map((c) => c.path)));
}

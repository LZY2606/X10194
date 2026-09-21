// 依赖图：乱序容忍、共享子图、循环检测
import type { RawAction } from "./types.ts";

export interface TopoResult {
  order: string[];
  /** 在循环中或依赖不存在的动作 id */
  invalid: Map<string, string>;
  byId: Map<string, RawAction>;
}

export function topoSort(actions: RawAction[]): TopoResult {
  const byId = new Map<string, RawAction>();
  for (const action of actions) byId.set(action.id, action);
  const invalid = new Map<string, string>();

  // Kahn 算法；未知依赖视为失败根
  const indegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const action of actions) {
    indegree.set(action.id, 0);
    dependents.set(action.id, new Set());
  }
  for (const action of actions) {
    for (const dep of new Set(action.deps)) {
      if (!byId.has(dep)) {
        invalid.set(action.id, `依赖动作 ${dep} 在清单中不存在`);
        continue;
      }
      indegree.set(action.id, (indegree.get(action.id) ?? 0) + 1);
      dependents.get(dep)!.add(action.id);
    }
  }

  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== actions.length) {
    for (const action of actions) {
      if (!order.includes(action.id) && !invalid.has(action.id)) {
        invalid.set(action.id, "依赖图存在循环");
      }
    }
  }
  return { order, invalid, byId };
}

/** 给定根动作，返回可达（含根）的全部动作 id */
export function reachableFrom(roots: string[], byId: Map<string, RawAction>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const action = byId.get(id);
    if (action) stack.push(...action.deps);
  }
  return seen;
}

/** 给定被污染的“叶子/文件所在动作”集合，返回依赖它们的全部下游（反向可达） */
export function downstreamFrom(seeds: Set<string>, byId: Map<string, RawAction>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const action of byId.values()) {
    for (const dep of action.deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(action.id);
    }
  }
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependents.get(id) ?? []) stack.push(next);
  }
  return seen;
}

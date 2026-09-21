import { composeKey, digestComponent, encodeList, sha256 } from './encoding';
import { normalizeCommand, normalizeEnv, normalizeInputs } from './rules';
import type {
  ActionManifest,
  ComponentDiff,
  Fingerprint,
  FingerprintComparison,
  RuleSpec,
} from './types';

/** 依赖结果版本：失败钉 "failed:<key>"，成功钉 key:outputHash */
export function depPinValue(key: string, outputHash: string, failed: boolean): string {
  return failed ? `failed:${key}` : `ok:${key}:${outputHash}`;
}

/** 计算输出摘要哈希（不参与 key；组成结果版本） */
export function outputHashOf(action: ActionManifest): string {
  const items = action.outputs
    .map((o) => `${o.path}|${o.algo}|${o.digest}`)
    .sort();
  return sha256(encodeList([action.id, ...items]));
}

export interface ComputeContext {
  rule: RuleSpec;
  /** depId -> 已算出的指纹 */
  depFingerprints: Map<string, Fingerprint>;
  /** 已知存在于清单集合的动作 id（含尚未计算的，用于区分缺失） */
  knownIds: Set<string>;
  /** path -> 纠正后的摘要（原始清单不可变，仅在此处生效） */
  digestOverrides: Map<string, { algo: string; digest: string }>;
}

/** 计算单个动作的完整指纹（要求依赖已先计算） */
export function computeFingerprint(action: ActionManifest, ctx: ComputeContext): Fingerprint {
  const notesAll: string[] = [];

  const cmd = normalizeCommand(action.command, ctx.rule);
  cmd.notes.forEach((n) => notesAll.push(`[command] ${n}`));
  const commandComp = {
    tag: 'command',
    label: '命令（含参数顺序/路径标志）',
    canonical: cmd.canonical,
    observed: action.command,
    digest: digestComponent('command', cmd.canonical),
    notes: cmd.notes,
  };

  const env = normalizeEnv(action.envObserved, action.envWhitelist, ctx.rule);
  env.notes.forEach((n) => notesAll.push(`[env] ${n}`));
  const envComp = {
    tag: 'env',
    label: '环境白名单',
    canonical: env.entries,
    observed: Object.entries(action.envObserved)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
    digest: digestComponent('env', env.entries),
    notes: env.notes,
  };

  const correctedInputPaths: string[] = [];
  const effectiveInputs = action.inputs.map((f) => {
    const fix = ctx.digestOverrides.get(f.path);
    if (fix && (fix.algo !== f.algo || fix.digest !== f.digest)) {
      correctedInputPaths.push(f.path);
      return { ...f, algo: fix.algo, digest: fix.digest };
    }
    return f;
  });
  const inputs = normalizeInputs(effectiveInputs, ctx.rule);
  inputs.notes.forEach((n) => notesAll.push(`[inputs] ${n}`));
  const inputsComp = {
    tag: 'inputs',
    label: '输入文件摘要（路径/symlink/x位）',
    canonical: inputs.entries,
    observed: action.inputs.map((f) => `${f.path}|${f.algo}|${f.digest}`),
    digest: digestComponent('inputs', inputs.entries),
    notes: inputs.notes,
  };

  const platformEntries = Object.entries(action.toolchain.platform)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const toolchainEntries = [
    `name=${action.toolchain.name}`,
    `version=${action.toolchain.version}`,
    ...platformEntries,
  ];
  const toolchainComp = {
    tag: 'toolchain',
    label: '工具链与平台属性',
    canonical: toolchainEntries,
    observed: toolchainEntries,
    digest: digestComponent('toolchain', toolchainEntries),
    notes: [],
  };

  // 依赖钉版本：共享子图只出现一次；缺失/阻塞依赖决定状态
  const depPins: Record<string, string> = {};
  const depNotes: string[] = [];
  let status: Fingerprint['status'] = action.failed ? 'failed' : 'ok';
  for (const depId of action.deps.slice().sort()) {
    if (!ctx.knownIds.has(depId)) {
      depPins[depId] = 'missing';
      depNotes.push(`依赖 ${depId} 尚未导入（乱序）`);
      if (status !== 'failed') status = 'missing-deps';
      continue;
    }
    const dep = ctx.depFingerprints.get(depId);
    if (!dep) {
      depPins[depId] = 'unresolved';
      depNotes.push(`依赖 ${depId} 尚待计算`);
      if (status !== 'failed') status = 'missing-deps';
      continue;
    }
    if (dep.status === 'missing-deps') {
      depPins[depId] = `unresolved:${dep.key}`;
      depNotes.push(`依赖 ${depId} 自身存在缺失依赖`);
      if (status !== 'failed') status = 'missing-deps';
      continue;
    }
    depPins[depId] = depPinValue(dep.key, dep.outputHash, dep.status === 'failed');
    if (dep.status === 'failed' || dep.status === 'blocked') {
      depNotes.push(`依赖 ${depId} 为 ${dep.status}，本动作不可产出`);
      status = 'blocked';
    }
  }
  const depEntries = Object.entries(depPins)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}@${v}`);
  const depsComp = {
    tag: 'deps',
    label: '依赖结果版本钉住',
    canonical: depEntries,
    observed: action.deps.slice().sort(),
    digest: digestComponent('deps', depEntries),
    notes: depNotes,
  };

  const pairs = [commandComp, envComp, inputsComp, toolchainComp, depsComp];
  const key = composeKey(
    pairs.map((c) => ({ tag: c.tag, digest: c.digest })),
    ctx.rule.version,
  );
  const outputHash = outputHashOf(action);
  const resultVersion = sha256(
    encodeList([key, outputHash, status === 'failed' ? 'failed' : status === 'blocked' ? 'blocked' : 'ok']),
  );

  return {
    actionId: action.id,
    key,
    components: pairs,
    depPins,
    status,
    ruleVersion: ctx.rule.version,
    outputHash,
    resultVersion,
    correctedInputPaths: correctedInputPaths.length ? correctedInputPaths : undefined,
  };
}

/** 拓扑序批量计算（支持共享子图；乱序缺失依赖标记 missing-deps） */
export function computeAll(
  actions: Map<string, ActionManifest>,
  rule: RuleSpec,
  digestOverrides: Map<string, { algo: string; digest: string }>,
): Map<string, Fingerprint> {
  const result = new Map<string, Fingerprint>();
  const visiting = new Set<string>();

  const visit = (id: string, trail: string[]): void => {
    if (result.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`依赖图存在环：${[...trail, id].join(' -> ')}`);
    }
    visiting.add(id);
    const action = actions.get(id);
    if (!action) return;
    for (const dep of action.deps) {
      if (actions.has(dep)) visit(dep, [...trail, id]);
    }
    result.set(
      id,
      computeFingerprint(action, {
        rule,
        depFingerprints: result,
        knownIds: new Set(actions.keys()),
        digestOverrides,
      }),
    );
    visiting.delete(id);
  };

  for (const id of [...actions.keys()].sort()) visit(id, []);
  return result;
}

/** 比较两个指纹：命中或未命中，逐组件给出差异 */
export function compareFingerprints(left: Fingerprint, right: Fingerprint): FingerprintComparison {
  const rightByTag = new Map(right.components.map((c) => [c.tag, c]));
  const components: ComponentDiff[] = [];
  const mismatchedTags: string[] = [];
  for (const lc of left.components) {
    const rc = rightByTag.get(lc.tag);
    const match = !!rc && lc.digest === rc.digest;
    if (!match) mismatchedTags.push(lc.tag);
    components.push({
      tag: lc.tag,
      label: lc.label,
      match,
      left: lc.canonical,
      right: rc ? rc.canonical : [],
      notes: [...new Set([...lc.notes, ...(rc?.notes ?? [])])],
    });
  }
  return {
    leftId: left.actionId,
    rightId: right.actionId,
    hit: left.key === right.key,
    leftKey: left.key,
    rightKey: right.key,
    components,
    mismatchedTags,
  };
}

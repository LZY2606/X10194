// 规范化：把原始动作转换为规范化形态，并记录每一步的解释。
// 原则：只有规则明确声明的等价关系才会被折叠；未声明的差异全部保留。
import type { RawAction, InputFile, DepRef } from './types';
import type { RuleSet } from './rules';

export interface NormNote {
  step: string;
  detail: string;
}

export interface NormalizedInput {
  path: string;
  digest: string;
  symlinkTarget: string | null;
  executable: boolean;
}

export interface NormalizedDep {
  actionId: string;
  resultVersion: number;
}

export interface NormalizedAction {
  id: string;
  command: string[];
  env: Record<string, string>;
  toolchain: string;
  platform: string;
  inputs: NormalizedInput[];
  deps: NormalizedDep[];
  outputs: string[];
  status: string;
  notes: NormNote[];
}

function normalizePath(raw: string, rules: RuleSet, notes: NormNote[]): string {
  let p = raw;
  if (p.includes('\\')) {
    const next = p.replace(/\\/g, '/');
    notes.push({ step: 'path.separator', detail: `路径分隔符统一: "${raw}" -> "${next}"` });
    p = next;
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  for (const alias of rules.pathAliases) {
    if (p === alias.from || p.startsWith(alias.from + '/')) {
      const next = alias.to + p.slice(alias.from.length);
      notes.push({ step: 'path.alias', detail: `路径别名: "${p}" -> "${next}"` });
      p = next;
      break;
    }
  }
  return p;
}

function normalizeSymlink(
  target: string | null,
  rules: RuleSet,
  notes: NormNote[],
): string | null {
  if (target === null) return null;
  const norm = normalizePath(target, rules, notes);
  for (const anchor of rules.symlinkAnchors) {
    if (norm === anchor || norm.startsWith(anchor + '/')) {
      const next = '@' + norm.slice(anchor.length);
      notes.push({ step: 'symlink.anchor', detail: `symlink 目标锚定: "${norm}" -> "${next}"` });
      return next;
    }
  }
  return norm;
}

function normalizeCommand(argv: string[], rules: RuleSet, notes: NormNote[]): string[] {
  if (argv.length === 0) return [];
  const out = [...argv];
  for (const alias of rules.commandAliases) {
    if (out[0] === alias.from) {
      notes.push({ step: 'command.alias', detail: `命令别名: "${alias.from}" -> "${alias.to}"` });
      out[0] = alias.to;
      break;
    }
  }
  // 仅对规则声明为“可交换”的 flag 值排序，其余参数顺序原样保留。
  for (const spec of rules.commutativeFlags) {
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== spec.flag) continue;
      const values = out.slice(i + 1, i + 1 + spec.valueCount);
      if (values.length < spec.valueCount) continue;
      const sorted = [...values].sort();
      if (sorted.join('') !== values.join('')) {
        notes.push({
          step: 'command.commutative',
          detail: `可交换参数排序: ${spec.flag} [${values.join(', ')}] -> [${sorted.join(', ')}]`,
        });
        out.splice(i + 1, spec.valueCount, ...sorted);
      }
      i += spec.valueCount;
    }
  }
  return out;
}

function normalizeEnv(
  declared: Record<string, string>,
  rules: RuleSet,
  notes: NormNote[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (rules.extraIgnoredEnv.includes(key)) {
      notes.push({ step: 'env.ignored', detail: `规则忽略环境变量: ${key}` });
      continue;
    }
    const canonical = rules.envAliases[key];
    if (canonical !== undefined && canonical !== key) {
      notes.push({ step: 'env.alias', detail: `环境变量别名: ${key} -> ${canonical}` });
      out[canonical] = value;
    } else {
      out[canonical ?? key] = value;
    }
  }
  return out;
}

export function normalizeAction(raw: RawAction, rules: RuleSet): NormalizedAction {
  const notes: NormNote[] = [];
  const command = normalizeCommand(raw.command, rules, notes);
  const env = normalizeEnv(raw.env, rules, notes);
  const inputs: NormalizedInput[] = raw.inputs.map((input: InputFile) => {
    const path = normalizePath(input.path, rules, notes);
    const symlinkTarget = normalizeSymlink(input.symlinkTarget ?? null, rules, notes);
    const executable = rules.ignoreExecBit ? false : input.executable === true;
    if (rules.ignoreExecBit && input.executable === true) {
      notes.push({ step: 'input.execbit', detail: `按规则忽略可执行位: ${path}` });
    }
    return { path, digest: input.digest, symlinkTarget, executable };
  });
  inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const deps: NormalizedDep[] = raw.deps.map((d: DepRef) => ({
    actionId: d.actionId,
    resultVersion: d.resultVersion ?? 1,
  }));
  deps.sort((a, b) =>
    a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : a.resultVersion - b.resultVersion,
  );
  const outputs = raw.outputs.map((o) => normalizePath(o, rules, notes)).sort();
  return {
    id: raw.id,
    command,
    env,
    toolchain: raw.toolchain,
    platform: raw.platform,
    inputs,
    deps,
    outputs,
    status: raw.status,
    notes,
  };
}

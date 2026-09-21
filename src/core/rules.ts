import type { RuleSpec } from './types';

/** v0：保守默认规则。不声明任何“激进”等价，避免人为抬高命中率。 */
export const DEFAULT_RULE: RuleSpec = {
  version: 0,
  pathAliases: [],
  normalizeSeparators: false,
  expandSymlinks: false,
  commutativeFlags: [],
  pathFlags: [],
  envValueAliases: {},
  digestAlgoAliases: {},
};

/** 深拷贝规则，供草案编辑 */
export function cloneRule(rule: RuleSpec): RuleSpec {
  return JSON.parse(JSON.stringify(rule)) as RuleSpec;
}

/**
 * 路径规范化。只处理规则明确声明为等价的部分：
 * 1. 别名前缀替换；
 * 2. 可选的分隔符统一；
 * 3. 可选的 symlink 展开（展开后仍走别名/分隔符规范化）。
 */
export function normalizePath(rawPath: string, rule: RuleSpec, symlinkTarget?: string): { value: string; note?: string } {
  let value = rawPath;
  const notes: string[] = [];

  const applyAliasAndSeparators = (p: string) => {
    let out = p;
    for (const alias of rule.pathAliases) {
      if (out === alias.from || out.startsWith(alias.from.endsWith('/') ? alias.from : `${alias.from}/`)) {
        out = alias.to + out.slice(alias.from.length);
        notes.push(`路径别名 ${alias.from} -> ${alias.to}`);
        break;
      }
    }
    if (rule.normalizeSeparators && out.includes('\\')) {
      out = out.replace(/\\/g, '/');
      notes.push('分隔符 \\ -> /');
    }
    return out;
  };

  if (rule.expandSymlinks && symlinkTarget !== undefined) {
    value = applyAliasAndSeparators(symlinkTarget);
    notes.push(`展开 symlink ${rawPath} -> ${symlinkTarget}`);
  } else {
    value = applyAliasAndSeparators(value);
    if (symlinkTarget !== undefined && !rule.expandSymlinks) {
      notes.push('symlink 未声明展开，保留原始路径');
    }
  }

  return { value, note: notes.length ? notes.join('；') : undefined };
}

/** 判断 argv 中某个 token 是否是值型标志（-x value 形式） */
function isPathValueFlag(token: string, rule: RuleSpec): boolean {
  return rule.pathFlags.includes(token);
}

/**
 * 命令规范化。
 * - 不为了命中率排序全部参数：只对声明的可交换标志的值做同标志内排序；
 * - 声明的路径标志值做路径规范化；
 * - argv[0]（可执行文件）做路径规范化（别名/symlink/分隔符）。
 */
export function normalizeCommand(
  argv: string[],
  rule: RuleSpec,
): { canonical: string[]; notes: string[] } {
  const notes: string[] = [];
  const out: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (i === 0) {
      const exe = normalizePath(token, rule);
      if (exe.note) notes.push(exe.note);
      out.push(exe.value);
      continue;
    }

    if (isPathValueFlag(token, rule) && i + 1 < argv.length) {
      const value = argv[i + 1];
      const np = normalizePath(value, rule);
      if (np.note) notes.push(`参数 ${token}：${np.note}`);
      out.push(token, np.value);
      i++;
      continue;
    }

    out.push(token);
  }

  // 可交换标志：同一标志名下的值排序（值在标志后一位）
  for (const flag of rule.commutativeFlags) {
    const positions: number[] = [];
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === flag) positions.push(i + 1);
    }
    if (positions.length > 1) {
      const values = positions.map((p) => out[p]).sort();
      positions.forEach((p, idx) => {
        out[p] = values[idx];
      });
      notes.push(`可交换标志 ${flag} 的 ${positions.length} 个值已排序`);
    }
  }

  return { canonical: out, notes };
}

/** 环境规范化：白名单外变量被排除并作为风险注记；取值别名按声明处理 */
export function normalizeEnv(
  observed: Record<string, string>,
  whitelist: string[],
  rule: RuleSpec,
): { entries: string[]; notes: string[] } {
  const notes: string[] = [];
  const allowed = new Set(whitelist);
  const undeclared = Object.keys(observed)
    .filter((k) => !allowed.has(k))
    .sort();
  if (undeclared.length > 0) {
    notes.push(`白名单外环境变量被排除（同名动作可能因此假性命中）：${undeclared.join(', ')}`);
  }
  const missing = whitelist.filter((k) => !(k in observed)).sort();
  for (const k of missing) notes.push(`白名单变量 ${k} 缺失，按空值计入`);

  const entries = whitelist.slice().sort().map((k) => {
    let value = observed[k] ?? '';
    const alias = rule.envValueAliases[k]?.[value];
    if (alias !== undefined) {
      notes.push(`环境 ${k} 取值等价 ${value} -> ${alias}`);
      value = alias;
    }
    return `${k}=${value}`;
  });
  return { entries, notes };
}

/** 输入规范化：路径规范化 + 摘要算法别名 + x 位/symlink 事实钉入，按规范路径排序 */
export function normalizeInputs(
  inputs: Array<{
    path: string;
    algo: string;
    digest: string;
    isSymlink?: boolean;
    symlinkTarget?: string;
    executable?: boolean;
  }>,
  rule: RuleSpec,
): { entries: string[]; notes: string[] } {
  const notes: string[] = [];
  const entries = inputs.map((f) => {
    const np = normalizePath(f.path, rule, f.isSymlink ? f.symlinkTarget : undefined);
    if (np.note) notes.push(`输入 ${f.path}：${np.note}`);
    let algo = f.algo;
    const canonicalAlgo = rule.digestAlgoAliases[algo];
    if (canonicalAlgo) {
      notes.push(`摘要算法 ${algo} -> ${canonicalAlgo}`);
      algo = canonicalAlgo;
    }
    const mode = f.executable ? 'x' : '-';
    return [np.value, algo, f.digest, mode, f.isSymlink ? 'symlink' : '-'].join('|');
  });
  entries.sort();
  return { entries, notes };
}

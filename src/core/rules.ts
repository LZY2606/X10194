import type { Ruleset, RulesetSpec } from './types.js';

/** Default ruleset v1: conservative, almost nothing is declared equivalent. */
export const DEFAULT_RULES_SPEC: RulesetSpec = {
  pathAliases: [],
  pathSeparatorEquivalent: false,
  argOrderInsensitive: [],
  envIgnore: [],
  resolveSymlinks: false,
  execBitMatters: true,
  platformKeys: ['os', 'arch'],
};

export function makeRuleset(version: number, spec: RulesetSpec): Ruleset {
  return { version, ...spec };
}

export function specOf(rules: Ruleset): RulesetSpec {
  const { version: _version, ...spec } = rules;
  return spec;
}

export interface PathNormalization {
  path: string;
  notes: string[];
}

/**
 * Normalize a path using ONLY declared equivalences:
 * separator equivalence and declared prefix aliases (longest match first).
 */
export function normalizePath(path: string, rules: Ruleset): PathNormalization {
  const notes: string[] = [];
  let result = path;
  if (rules.pathSeparatorEquivalent && result.includes('\\')) {
    result = result.replace(/\\/g, '/');
    notes.push(`路径分隔符已按声明等价规则统一为 "/": ${path} -> ${result}`);
  }
  const aliases = [...rules.pathAliases].sort((a, b) => b.from.length - a.from.length);
  for (const alias of aliases) {
    const from = rules.pathSeparatorEquivalent ? alias.from.replace(/\\/g, '/') : alias.from;
    if (result === from || result.startsWith(from.endsWith('/') ? from : from + '/')) {
      const rest = result.slice(from.length);
      result = alias.to + rest;
      notes.push(`路径别名 ${from} -> ${alias.to} 已应用: ${result}`);
      break;
    }
  }
  return { path: result, notes };
}

export interface ArgvNormalization {
  argv: string[];
  notes: string[];
}

/**
 * Sort ONLY consecutive runs of arguments that all match a declared
 * order-insensitive pattern. Everything else keeps its exact position.
 */
export function normalizeArgv(argv: string[], rules: Ruleset): ArgvNormalization {
  const notes: string[] = [];
  const patterns = rules.argOrderInsensitive.map((source) => new RegExp(source));
  if (patterns.length === 0) return { argv: [...argv], notes };
  const result: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 1) {
      const sorted = [...run].sort();
      if (sorted.some((value, index) => value !== run[index])) {
        notes.push(`参数组 [${run.join(', ')}] 按声明等价规则排序为 [${sorted.join(', ')}]`);
      }
      result.push(...sorted);
    } else {
      result.push(...run);
    }
    run = [];
  };
  for (const arg of argv) {
    if (patterns.some((pattern) => pattern.test(arg))) {
      run.push(arg);
    } else {
      flush();
      result.push(arg);
    }
  }
  flush();
  return { argv: result, notes };
}

export interface EnvNormalization {
  env: Record<string, string>;
  dropped: string[];
  undeclared: string[];
  notes: string[];
}

/**
 * Env is a set of bindings, so keys are canonically sorted. Variables in
 * envIgnore are declared irrelevant and dropped. Captured variables that the
 * action never declared (not in envWhitelist) are KEPT but flagged, because
 * undeclared environment may still change semantics.
 */
export function normalizeEnv(
  env: Record<string, string>,
  envWhitelist: string[],
  rules: Ruleset,
): EnvNormalization {
  const notes: string[] = [];
  const dropped: string[] = [];
  const undeclared: string[] = [];
  const result: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    if (rules.envIgnore.includes(name)) {
      dropped.push(name);
      notes.push(`环境变量 ${name} 被规则声明为无关，已剔除`);
      continue;
    }
    if (!envWhitelist.includes(name)) {
      undeclared.push(name);
      notes.push(`环境变量 ${name} 未在动作白名单中声明，仍计入指纹`);
    }
    result[name] = env[name];
  }
  return { env: result, dropped, undeclared, notes };
}

// 规范化：只折叠规则里明确声明为等价的部分，其余逐字节钉住。

import type { FileRecord, PlatformInfo, RawAction, RuleSet, Transform } from './types';

export function defaultRules(): RuleSet {
  return {
    pathAliases: [],
    normalizeSeparators: false,
    unorderedFlags: [],
    envAliases: [],
    symlinkAliases: [],
    ignoreExecutableBit: false,
    ignoredPlatformAttributes: [],
  };
}

/** 分隔符规范化（必须显式开启） */
export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/** 长前缀优先的路径别名，返回 (规范化路径, 是否命中别名) */
export function applyPathAliases(
  path: string,
  aliases: { from: string; to: string }[],
): { path: string; matched: { from: string; to: string } | null } {
  const sorted = [...aliases].sort((a, b) => b.from.length - a.from.length);
  for (const alias of sorted) {
    if (path === alias.from || path.startsWith(alias.from.endsWith('/') ? alias.from : `${alias.from}/`)) {
      return { path: alias.to + path.slice(alias.from.length), matched: alias };
    }
  }
  return { path, matched: null };
}

/** 规范化一个路径：先分隔符（如开启），再别名。 */
export function canonicalPath(
  rawPath: string,
  rules: RuleSet,
  transforms: Transform[],
  segment: string,
): string {
  let p = rawPath;
  if (rules.normalizeSeparators && p.includes('\\')) {
    const before = p;
    p = normalizeSeparators(p);
    transforms.push({
      segment,
      raw: before,
      canonical: p,
      reason: '规则 normalizeSeparators：反斜杠折叠为正斜杠',
    });
  }
  const aliasResult = applyPathAliases(p, rules.pathAliases);
  if (aliasResult.matched) {
    transforms.push({
      segment,
      raw: p,
      canonical: aliasResult.path,
      reason: `路径别名 ${aliasResult.matched.from} -> ${aliasResult.matched.to}（长前缀优先）`,
    });
  }
  return aliasResult.path;
}

export function applyEnvAlias(
  key: string,
  aliases: { from: string; to: string }[],
): { key: string; matched: { from: string; to: string } | null } {
  const found = aliases.find((a) => a.from === key);
  return found ? { key: found.to, matched: found } : { key, matched: null };
}

interface CommandToken {
  kind: 'value' | 'flag' | 'inline-value';
  text: string;
  flag?: string;
}

function splitInline(token: string): { flag: string; value: string } | null {
  // 支持 -j8、--jobs=8 两种内联形式
  const eq = token.match(/^(--?[^=]+)=(.+)$/);
  if (eq) return { flag: eq[1], value: eq[2] };
  const short = token.match(/^(-[A-Za-z])(.+)$/);
  if (short) return { flag: short[1], value: short[2] };
  return null;
}

/**
 * 规范化命令行：
 *  - 只有声明在 unorderedFlags 中的 flag 之后的值被收集、排序；
 *  - 未声明的参数保持原始顺序，绝不全局排序；
 *  - 排序后的值组放回该 flag 第一次出现的位置，保证确定性。
 */
export function canonicalCommand(
  argv: string[],
  rules: RuleSet,
  transforms: Transform[],
): string[] {
  const unordered = new Set(rules.unorderedFlags);
  if (unordered.size === 0) return [...argv];

  const tokens: CommandToken[] = [];
  let pendingFlag: string | null = null;
  for (const raw of argv) {
    if (pendingFlag !== null) {
      tokens.push({ kind: 'inline-value', text: raw, flag: pendingFlag });
      pendingFlag = null;
      continue;
    }
    const inline = splitInline(raw);
    if (inline && unordered.has(inline.flag)) {
      tokens.push({ kind: 'flag', text: inline.flag, flag: inline.flag });
      tokens.push({ kind: 'inline-value', text: inline.value, flag: inline.flag });
      continue;
    }
    if (raw.startsWith('-') && unordered.has(raw)) {
      tokens.push({ kind: 'flag', text: raw, flag: raw });
      pendingFlag = raw;
      continue;
    }
    tokens.push({ kind: 'value', text: raw });
  }

  // 每个 unordered flag 的值出现位置（用于解释）
  const valuesByFlag = new Map<string, string[]>();
  const firstIndexByFlag = new Map<string, number>();
  tokens.forEach((tok, idx) => {
    if (tok.kind === 'inline-value' && tok.flag && unordered.has(tok.flag)) {
      const list = valuesByFlag.get(tok.flag) ?? [];
      list.push(tok.text);
      valuesByFlag.set(tok.flag, list);
      if (!firstIndexByFlag.has(tok.flag)) firstIndexByFlag.set(tok.flag, idx);
    }
  });

  for (const [flag, values] of valuesByFlag) {
    const sorted = [...values].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(values)) {
      transforms.push({
        segment: 'command',
        raw: values,
        canonical: sorted,
        reason: `unorderedFlags 声明 ${flag} 的值顺序无关：收集后按 UTF-8 排序，其他参数顺序不动`,
      });
    }
  }

  const consumed = new Set<string>();
  const out: string[] = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.kind === 'inline-value' && tok.flag && unordered.has(tok.flag)) {
      if (consumed.has(tok.flag)) continue;
      consumed.add(tok.flag);
      out.push(...(valuesByFlag.get(tok.flag) ?? []).slice().sort());
      continue;
    }
    if (tok.kind === 'flag' && tok.flag && unordered.has(tok.flag) && idx + 1 < tokens.length) {
      const next = tokens[idx + 1];
      // 后一个 token 会渲染整个排序组
      if (next.kind === 'inline-value' && next.flag === tok.flag) continue;
    }
    out.push(tok.text);
  }
  return out;
}

export interface EnvNormalization {
  canonical: Record<string, string>;
  missing: string[];
  undeclared: string[];
}

/** 环境：只取白名单变量；缺失与未声明分别记录，绝不静默补默认值。 */
export function canonicalEnv(action: RawAction, rules: RuleSet, transforms: Transform[]): EnvNormalization {
  const canonical: Record<string, string> = {};
  const missing: string[] = [];
  for (const declared of action.envWhitelist) {
    const { key, matched } = applyEnvAlias(declared, rules.envAliases);
    if (matched) {
      transforms.push({
        segment: `env:${declared}`,
        raw: declared,
        canonical: key,
        reason: `环境别名 ${matched.from} -> ${matched.to}`,
      });
    }
    if (action.envObserved[key] !== undefined) {
      canonical[key] = action.envObserved[key];
    } else if (action.envObserved[declared] !== undefined && declared !== key) {
      canonical[key] = action.envObserved[declared];
    } else {
      missing.push(key);
    }
  }
  const declaredCanonical = new Set(
    action.envWhitelist.map((k) => applyEnvAlias(k, rules.envAliases).key),
  );
  const undeclared = Object.keys(action.envObserved)
    .filter((k) => !declaredCanonical.has(applyEnvAlias(k, rules.envAliases).key))
    .sort();
  return { canonical, missing, undeclared };
}

export function canonicalPlatform(
  platform: PlatformInfo,
  rules: RuleSet,
  transforms: Transform[],
): CanonicalPlatform {
  const ignored = new Set(rules.ignoredPlatformAttributes);
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(platform.attributes ?? {})) {
    if (ignored.has(key)) {
      transforms.push({
        segment: `platform:${key}`,
        raw: value,
        canonical: null,
        reason: `规则忽略平台属性 ${key}（os/arch 永不忽略）`,
      });
      continue;
    }
    attrs[key] = value;
  }
  return { os: platform.os, arch: platform.arch, attributes: attrs };
}

export interface CanonicalPlatform {
  os: string;
  arch: string;
  attributes: Record<string, string>;
}

export interface CanonicalFile {
  path: string;
  digest: string;
  mode: number;
  executable: boolean;
  symlink: { target: string; targetDigest: string | null } | null;
}

export function canonicalFile(file: FileRecord, rules: RuleSet, transforms: Transform[]): CanonicalFile {
  const path = canonicalPath(file.path, rules, transforms, `input:${file.path}`);
  const executable = (file.mode & 0o111) !== 0;
  let mode = file.mode;
  if (rules.ignoreExecutableBit && executable) {
    mode = file.mode & ~0o111;
    transforms.push({
      segment: `input:${file.path}#mode`,
      raw: `0o${file.mode.toString(8)}`,
      canonical: `0o${mode.toString(8)}`,
      reason: '规则 ignoreExecutableBit：清除可执行位',
    });
  }
  let symlink: CanonicalFile['symlink'] = null;
  if (file.symlink) {
    let target = file.symlink.target;
    if (rules.normalizeSeparators && target.includes('\\')) {
      const before = target;
      target = normalizeSeparators(target);
      transforms.push({
        segment: `input:${file.path}#symlink`,
        raw: before,
        canonical: target,
        reason: 'symlink 目标同样应用分隔符规范化',
      });
    }
    const aliasResult = applyPathAliases(target, rules.symlinkAliases);
    if (aliasResult.matched) {
      transforms.push({
        segment: `input:${file.path}#symlink`,
        raw: target,
        canonical: aliasResult.path,
        reason: `symlink 目标别名 ${aliasResult.matched.from} -> ${aliasResult.matched.to}`,
      });
    }
    target = aliasResult.path;
    symlink = { target, targetDigest: file.symlink.targetDigest ?? null };
  }
  return { path, digest: file.digest, mode, executable, symlink };
}

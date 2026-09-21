import { createHash } from 'node:crypto';
import type {
  ActionManifest,
  Fingerprint,
  KeyComponent,
  NormalizationRules,
} from './types.js';

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function hashCanonical(value: unknown): string {
  // All hash input is canonical JSON encoded explicitly as UTF-8 bytes.
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function normalizePath(p: string, rules: NormalizationRules, notes: string[]): string {
  let out = p;
  if (rules.normalizePathSeparator && out.includes('\\')) {
    out = out.replace(/\\/g, '/');
    notes.push(`路径分隔符已规范化: ${p} -> ${out}`);
  }
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  const sorted = [...rules.pathAliases].sort((a, b) => b.from.length - a.from.length);
  for (const alias of sorted) {
    const from = rules.normalizePathSeparator ? alias.from.replace(/\\/g, '/') : alias.from;
    if (out === from || out.startsWith(from + '/')) {
      const replaced = alias.to + out.slice(from.length);
      notes.push(`路径别名: ${out} -> ${replaced}`);
      out = replaced;
      break;
    }
  }
  return out;
}

function normalizeArgv(
  argv: string[],
  rules: NormalizationRules,
  notes: string[],
): string[] {
  if (argv.length === 0) return argv;
  const head = argv[0];
  const rest = argv.slice(1);
  const eq = rules.argOrderEquivalences.find((e) => e.argv0 === head);
  if (!eq) return argv;
  const isSortable = (tok: string) =>
    eq.flags.some((f) => tok === f || tok.startsWith(f));
  const sortable = rest.filter(isSortable);
  if (sortable.length < 2) return argv;
  const sorted = [...sortable].sort();
  const result: string[] = [head];
  let i = 0;
  for (const tok of rest) {
    if (isSortable(tok)) {
      result.push(sorted[i++]);
    } else {
      result.push(tok);
    }
  }
  notes.push(`参数顺序已按声明等价排序 (${eq.argv0}: ${eq.flags.join(', ')}): [${rest.join(' ')}] -> [${result.slice(1).join(' ')}]`);
  return result;
}

export interface EngineContext {
  actions: Map<string, ActionManifest>;
  visiting?: Set<string>;
}

export function computeFingerprint(
  action: ActionManifest,
  rules: NormalizationRules,
  ctx: EngineContext,
): Fingerprint {
  const components: KeyComponent[] = [];
  let pending = false;
  const visiting = ctx.visiting ?? new Set<string>();
  if (visiting.has(action.id)) {
    return { actionId: action.id, key: 'cycle', components: [], pending: true };
  }
  visiting.add(action.id);
  const childCtx: EngineContext = { actions: ctx.actions, visiting };

  const argvNotes: string[] = [];
  const argv = normalizeArgv(action.command.argv, rules, argvNotes);
  const cwdNotes: string[] = [];
  const cwd = normalizePath(action.command.cwd, rules, cwdNotes);
  components.push({ name: 'command', value: { argv, cwd }, notes: [...argvNotes, ...cwdNotes] });

  const envNotes: string[] = [];
  const whitelist = new Set(action.envWhitelist);
  const envEntries = Object.entries(action.env).sort(([a], [b]) => a.localeCompare(b));
  const envUsed: Record<string, string> = {};
  for (const [k, v] of envEntries) {
    if (whitelist.has(k)) {
      envUsed[k] = v;
    } else if (rules.ignoreUndeclaredEnv) {
      envNotes.push(`未声明环境变量已忽略: ${k}`);
    } else {
      envUsed[k] = v;
      envNotes.push(`未声明环境变量仍计入指纹(保守): ${k}`);
    }
  }
  for (const k of [...whitelist].sort()) {
    if (!(k in action.env)) envNotes.push(`白名单环境变量缺失: ${k}`);
  }
  components.push({ name: 'env', value: envUsed, notes: envNotes });

  components.push({ name: 'toolchain', value: action.toolchain, notes: [] });

  const inputNotes: string[] = [];
  const inputs = action.inputs.map((inp) => {
    const pNotes: string[] = [];
    const normPath = normalizePath(inp.path, rules, pNotes);
    inputNotes.push(...pNotes);
    const rec: Record<string, unknown> = { path: normPath, digest: inp.digest };
    if (inp.symlinkTarget != null) {
      if (rules.symlinkMode === 'target') {
        const tNotes: string[] = [];
        rec.target = normalizePath(inp.symlinkTarget, rules, tNotes);
        inputNotes.push(...tNotes);
        inputNotes.push(`symlink 按目标解析: ${normPath} -> ${rec.target}`);
      } else {
        inputNotes.push(`symlink 按不透明处理: ${normPath}`);
      }
    }
    if (rules.includeExecutableBit) {
      rec.executable = inp.executable === true;
    } else if (inp.executable) {
      inputNotes.push(`可执行位已忽略: ${normPath}`);
    }
    return rec;
  });
  inputs.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  components.push({ name: 'inputs', value: inputs, notes: inputNotes });

  const depNotes: string[] = [];
  const deps = [...action.deps].sort().map((depId) => {
    const dep = ctx.actions.get(depId);
    if (!dep) {
      pending = true;
      depNotes.push(`依赖 ${depId} 尚未导入,指纹为临时值`);
      return { id: depId, result: 'pending' };
    }
    const depFp = computeFingerprint(dep, rules, childCtx);
    if (depFp.pending) pending = true;
    if (dep.status === 'failed') {
      depNotes.push(`依赖 ${depId} 状态为 failed,已钉住失败结果版本`);
    }
    return { id: depId, result: `${depFp.key}:${dep.status}` };
  });
  components.push({ name: 'deps', value: deps, notes: depNotes });

  const platformNotes: string[] = [];
  const platform: Record<string, string> = {};
  for (const prop of [...rules.platformProperties].sort()) {
    if (prop in action.platform) {
      platform[prop] = action.platform[prop];
    } else {
      platformNotes.push(`平台属性缺失: ${prop}`);
    }
  }
  components.push({ name: 'platform', value: platform, notes: platformNotes });

  visiting.delete(action.id);
  const key = hashCanonical({
    v: rules.version,
    components: Object.fromEntries(components.map((c) => [c.name, c.value])),
  });
  return { actionId: action.id, key, components, pending };
}

export function computeAllFingerprints(
  actions: ActionManifest[],
  rules: NormalizationRules,
): Fingerprint[] {
  const ctx: EngineContext = { actions: new Map(actions.map((a) => [a.id, a])) };
  return actions.map((a) => computeFingerprint(a, rules, ctx));
}

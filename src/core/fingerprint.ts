import { concat, frame, hashFrame, kv, seq, sha256 } from './encode';
import { buildEnvComponents, normalizeArgv, normalizePathValue } from './normalize';
import type {
  ActionSpec,
  ComponentDiff,
  Fingerprint,
  FingerprintComparison,
  FingerprintExplain,
  InputComponent,
  NormalizationRule,
  OutputFile,
  ResolvedDep,
} from './types';

export function buildExplain(
  action: ActionSpec,
  rules: NormalizationRule[],
  resolvedDeps: ResolvedDep[],
  ruleVersion: number,
): FingerprintExplain {
  const { command, argv } = normalizeArgv(action.command, action.argv, rules);
  const cwd = normalizePathValue(action.cwd, rules);

  const inputs: InputComponent[] = action.inputs
    .map((f) => {
      const p = normalizePathValue(f.path, rules);
      return {
        rawPath: f.path,
        normalizedPath: p.normalized,
        digest: f.digest,
        mode: f.mode,
        symlinkTarget: f.symlinkTarget ?? null,
        notes: p.notes,
      };
    })
    .sort((a, b) => (a.normalizedPath < b.normalizedPath ? -1 : 1));

  const depById = new Map(resolvedDeps.map((d) => [d.actionId, d]));
  const deps = [...action.deps]
    .sort()
    .map((actionId) => {
      const d = depById.get(actionId);
      if (!d) throw new Error(`unresolved dependency ${actionId} for ${action.id}`);
      return {
        actionId,
        pinnedResultVersion: d.resultVersion,
        outputSetHash: d.outputSetHash,
        status: d.status,
      };
    });

  return {
    actionId: action.id,
    ruleVersion,
    command,
    argv,
    cwd,
    toolchain: { ...action.toolchain },
    platform: { ...action.platform },
    env: buildEnvComponents(action.env, action.envWhitelist),
    inputs,
    deps,
    status: action.status,
  };
}

/**
 * Explicit byte encoding of one component. All strings are UTF-8; every field
 * is length-framed, so concatenation cannot introduce ambiguity.
 */
export function componentBytes(name: string, explain: FingerprintExplain): Uint8Array {
  switch (name) {
    case 'command':
      // Identity uses the normalized value only; raw text and notes live in
      // the explanation and must not perturb the key.
      return kv('norm', explain.command.normalized);
    case 'argv':
      return seq(
        explain.argv.map((t) =>
          concat([kv('norm', t.normalized), kv('group', t.group ?? '')]),
        ),
      );
    case 'cwd':
      return kv('norm', explain.cwd.normalized);
    case 'toolchain':
      return concat([kv('name', explain.toolchain.name), kv('version', explain.toolchain.version)]);
    case 'platform':
      return concat([kv('os', explain.platform.os), kv('arch', explain.platform.arch)]);
    case 'env':
      // Only whitelist-declared variables contribute to identity; undeclared
      // vars are surfaced in the explanation but never silently affect keys.
      return seq(
        explain.env
          .filter((e) => e.declared)
          .map((e) =>
            concat([
              kv('name', e.name),
              // 0x01 present, 0x00 missing — absence is semantically significant.
              frame('present', e.present ? new Uint8Array([1]) : new Uint8Array([0])),
              kv('value', e.normalizedValue ?? ''),
            ]),
          ),
      );
    case 'inputs':
      return seq(
        explain.inputs.map((f) =>
          concat([
            kv('norm', f.normalizedPath),
            kv('digest', f.digest),
            // mode decimal text keeps the encoding explicit
            kv('mode', String(f.mode)),
            kv('symlink', f.symlinkTarget ?? ''),
          ]),
        ),
      );
    case 'deps':
      return seq(
        explain.deps.map((d) =>
          concat([
            kv('action', d.actionId),
            kv('resultVersion', String(d.pinnedResultVersion)),
            kv('outputSetHash', d.outputSetHash),
            kv('status', d.status),
          ]),
        ),
      );
    case 'status':
      return kv('status', explain.status);
    default:
      throw new Error(`unknown component ${name}`);
  }
}

export const COMPONENT_NAMES = [
  'command',
  'argv',
  'cwd',
  'toolchain',
  'platform',
  'env',
  'inputs',
  'deps',
  'status',
] as const;

export function fingerprint(
  action: ActionSpec,
  rules: NormalizationRule[],
  resolvedDeps: ResolvedDep[],
  ruleVersion: number,
): Fingerprint {
  const explain = buildExplain(action, rules, resolvedDeps, ruleVersion);
  const components = COMPONENT_NAMES.map((name) => ({
    name,
    hash: hashFrame(`component:${name}`, componentBytes(name, explain)),
  }));
  const body = concat([
    kv('ruleVersion', String(ruleVersion)),
    seq(
      components.map((c) => concat([kv('name', c.name), kv('hash', c.hash)])),
    ),
  ]);
  return { key: sha256(frame('fingerprint', body)), explain, components };
}

/** Outputs are never part of the key; they identify the produced result. */
export function outputSetHash(outputs: OutputFile[]): string {
  const body = seq(
    [...outputs]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) =>
        concat([
          kv('path', f.path),
          kv('digest', f.digest),
          kv('mode', String(f.mode)),
          kv('symlink', f.symlinkTarget ?? ''),
        ]),
      ),
  );
  return hashFrame('outputSet', body);
}

function summarize(name: string, explain: FingerprintExplain): string {
  switch (name) {
    case 'command':
      return explain.command.normalized;
    case 'argv':
      return explain.argv.map((t) => t.normalized).join(' ');
    case 'cwd':
      return explain.cwd.normalized;
    case 'toolchain':
      return `${explain.toolchain.name}@${explain.toolchain.version}`;
    case 'platform':
      return `${explain.platform.os}/${explain.platform.arch}`;
    case 'env':
      return explain.env
        .map((e) => `${e.name}=${e.present ? e.normalizedValue : '<缺失>'}${e.declared ? '' : '(未声明)'}`)
        .join(' ');
    case 'inputs':
      return explain.inputs
        .map((f) => `${f.normalizedPath}:${f.digest.slice(0, 8)}:${f.mode.toString(8)}${f.symlinkTarget ? '->' + f.symlinkTarget : ''}`)
        .join(' ');
    case 'deps':
      return explain.deps.map((d) => `${d.actionId}#v${d.pinnedResultVersion}`).join(' ');
    default:
      return '';
    case 'status':
      return explain.status;
  }
}

export function compareFingerprints(a: Fingerprint, b: Fingerprint): FingerprintComparison {
  const diffs: ComponentDiff[] = [];
  for (const name of COMPONENT_NAMES) {
    const ha = a.components.find((c) => c.name === name)!;
    const hb = b.components.find((c) => c.name === name)!;
    const sa = summarize(name, a.explain);
    const sb = summarize(name, b.explain);
    diffs.push({
      component: name,
      same: ha.hash === hb.hash,
      a: sa,
      b: sb,
      detail:
        ha.hash === hb.hash
          ? '一致'
          : name === 'deps'
            ? '依赖钉住的结果版本或输出不同'
            : name === 'status'
              ? '动作成败状态不同'
              : '该组成部分语义不同',
    });
  }
  return {
    actionA: a.explain.actionId,
    actionB: b.explain.actionId,
    ruleVersion: a.explain.ruleVersion,
    verdict: a.key === b.key ? 'hit' : 'miss',
    keyA: a.key,
    keyB: b.key,
    diffs,
  };
}

/** Transitive reachability (including self) over a dep->dependents graph. */
export function reachable(startIds: string[], dependents: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [...startIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of dependents.get(id) ?? []) stack.push(child);
  }
  return out;
}

export function buildDependents(deps: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, ds] of deps) {
    if (!out.has(id)) out.set(id, []);
    for (const d of ds) {
      if (!out.has(d)) out.set(d, []);
      out.get(d)!.push(id);
    }
  }
  return out;
}

import { fingerprint, outputSetHash } from '../src/core/fingerprint';
import type { ActionSpec, NormalizationRule, ResolvedDep } from '../src/core/types';

let counter = 0;
export function digest(seed: string): string {
  counter += 1;
  let h = '';
  let x = 0;
  for (let i = 0; i < 64; i++) {
    x = (x * 31 + seed.charCodeAt(i % seed.length) + i * 7 + counter) >>> 0;
    h += (x % 16).toString(16);
  }
  return h;
}

export interface SpecOpts {
  id?: string;
  observedAt?: number;
  command?: string;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  whitelist?: string[];
  inputs?: ActionSpec['inputs'];
  deps?: string[];
  outputs?: ActionSpec['outputs'];
  status?: 'success' | 'failed';
  platform?: ActionSpec['platform'];
  mode?: number;
  toolchain?: ActionSpec['toolchain'];
}

export function spec(o: SpecOpts = {}): ActionSpec {
  return {
    id: o.id ?? `a${counter}`,
    observedAt: o.observedAt ?? 1000,
    command: o.command ?? '/usr/bin/gcc',
    argv: o.argv ?? ['-c', 'src/main.c'],
    cwd: o.cwd ?? '/home/ci/project',
    env: o.env ?? { PATH: '/usr/bin' },
    envWhitelist: o.whitelist ?? ['PATH'],
    toolchain: o.toolchain ?? { name: 'gcc', version: '13.2' },
    platform: o.platform ?? { os: 'linux', arch: 'x64' },
    inputs: o.inputs ?? [{ path: 'src/main.c', digest: digest('main'), mode: 0o644 }],
    deps: o.deps ?? [],
    outputs: o.outputs ?? [{ path: 'build/main.o', digest: digest('main.o'), mode: 0o644 }],
    status: o.status ?? 'success',
  };
}

export function keyOf(action: ActionSpec, rules: NormalizationRule[] = [], deps: ResolvedDep[] = [], rv = 1) {
  return fingerprint(action, rules, deps, rv).key;
}

export { outputSetHash };

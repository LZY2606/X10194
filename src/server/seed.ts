import type { ActionSpec, Manifest } from '../core/types';

// Deterministic placeholder digests (64 hex chars each), so demos and tests
// stay reproducible without hashing real file contents.
function d(seed: string): string {
  let h = '';
  let x = 0;
  for (let i = 0; i < 64; i++) {
    x = (x * 31 + seed.charCodeAt(i % seed.length) + i * 7) >>> 0;
    h += (x % 16).toString(16);
  }
  return h;
}

const GCC = { name: 'gcc', version: '13.2.0' };
const LINUX = { os: 'linux', arch: 'x64' };
const MAC = { os: 'darwin', arch: 'arm64' };

type A = Partial<ActionSpec> & Pick<ActionSpec, 'id' | 'observedAt' | 'command' | 'argv' | 'cwd' | 'status'>;

function make(a: A): ActionSpec {
  return {
    env: {},
    envWhitelist: ['PATH', 'CC'],
    toolchain: GCC,
    platform: LINUX,
    inputs: [],
    deps: [],
    outputs: [],
    exitCode: a.status === 'failed' ? 1 : 0,
    errorText: a.status === 'failed' ? 'compile error' : null,
    ...a,
  } as ActionSpec;
}

function manifest(manifestId: string, importedAt: number, actions: ActionSpec[]): Manifest {
  return { manifestId, importedAt, actions };
}

// ---- M1: baseline builds with a shared generated header sub-graph --------
const m1 = manifest('m1-base', 1700_000_000, [
  make({
    id: 'gen_config',
    observedAt: 1000,
    command: '/opt/toolchain/bin/python3',
    argv: ['tools/gen_config.py', '--out', 'build/config.h'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [{ path: 'tools/gen_config.py', digest: d('gen_config.py'), mode: 0o755 }],
    outputs: [{ path: 'build/config.h', digest: d('config.h@1'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'compile_core',
    observedAt: 1100,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', '-Wall', '-Ibuild', '-Ithird_party/include', 'src/core.c', '-o', 'build/core.o'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [
      { path: 'src/core.c', digest: d('core.c'), mode: 0o644 },
      { path: 'build/config.h', digest: d('config.h@1'), mode: 0o644 },
    ],
    deps: ['gen_config'],
    outputs: [{ path: 'build/core.o', digest: d('core.o@1'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'compile_net',
    observedAt: 1200,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', '-Wall', '-Ithird_party/include', '-Ibuild', 'src/net.c', '-o', 'build/net.o'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [
      { path: 'src/net.c', digest: d('net.c'), mode: 0o644 },
      { path: 'build/config.h', digest: d('config.h@1'), mode: 0o644 },
    ],
    deps: ['gen_config'],
    outputs: [{ path: 'build/net.o', digest: d('net.o@1'), mode: 0o644 }],
    status: 'success',
  }),
]);

export const SEED_DIGEST = d;

// ---- M2: repeat of gen_config yields a different output -> dispute;
// failed dep failure must be pinned, never silently hit --------------------
const m2 = manifest('m2-repeat-and-fail', 1700_003_600, [
  make({
    id: 'gen_config',
    observedAt: 2000,
    command: '/opt/toolchain/bin/python3',
    argv: ['tools/gen_config.py', '--out', 'build/config.h'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [{ path: 'tools/gen_config.py', digest: d('gen_config.py'), mode: 0o755 }],
    outputs: [{ path: 'build/config.h', digest: d('config.h@DIFFERENT'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'compile_core',
    observedAt: 2100,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', '-Wall', '-Ibuild', '-Ithird_party/include', 'src/core.c', '-o', 'build/core.o'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [
      { path: 'src/core.c', digest: d('core.c'), mode: 0o644 },
      { path: 'build/config.h', digest: d('config.h@DIFFERENT'), mode: 0o644 },
    ],
    deps: ['gen_config'],
    outputs: [{ path: 'build/core.o', digest: d('core.o@2'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'flaky_codegen',
    observedAt: 2200,
    command: '/opt/toolchain/bin/python3',
    argv: ['tools/codegen.py'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin' },
    inputs: [{ path: 'tools/codegen.py', digest: d('codegen.py'), mode: 0o644 }],
    outputs: [],
    status: 'failed',
    errorText: 'codegen crashed',
  }),
  make({
    id: 'consume_codegen',
    observedAt: 2300,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', 'build/generated.c', '-o', 'build/generated.o'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [{ path: 'build/generated.c', digest: d('generated.c@broken'), mode: 0o644 }],
    deps: ['flaky_codegen'],
    outputs: [],
    status: 'failed',
    errorText: 'dependency failed',
  }),
]);

// ---- M3: windows-style path/separator twin; undeclared env; platform; x bit
const m3 = manifest('m3-semantic-variants', 1700_007_200, [
  make({
    id: 'compile_winpath',
    observedAt: 3000,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', '-Wall', '-Ibuild', '-Ithird_party/include', 'src/core.c', '-o', 'build/core.o'],
    cwd: 'C:\\Users\\ci\\project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    inputs: [
      { path: 'src\\core.c', digest: d('core.c'), mode: 0o644 },
      { path: 'build\\config.h', digest: d('config.h@1'), mode: 0o644 },
    ],
    deps: [],
    outputs: [{ path: 'build/core.o', digest: d('core.o@1'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'env_build',
    observedAt: 3100,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', 'src/env.c', '-o', 'build/env.o'],
    cwd: '/home/ci/project',
    // EXTRA_TOOL is present but NOT on the whitelist.
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc', EXTRA_TOOL: '/opt/unlisted/bin' },
    envWhitelist: ['PATH', 'CC'],
    inputs: [{ path: 'src/env.c', digest: d('env.c@extra'), mode: 0o644 }],
    outputs: [{ path: 'build/env.o', digest: d('env.o@extra'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'env_clean_build',
    observedAt: 3150,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', 'src/env.c', '-o', 'build/env.o'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin', CC: 'gcc' },
    envWhitelist: ['PATH', 'CC'],
    inputs: [{ path: 'src/env.c', digest: d('env.c@extra'), mode: 0o644 }],
    outputs: [{ path: 'build/env.o', digest: d('env.o@extra'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'platform_build',
    observedAt: 3200,
    command: '/opt/toolchain/bin/gcc',
    argv: ['-c', 'src/core.c', '-o', 'build/core.o'],
    cwd: '/home/ci/project',
    platform: MAC,
    inputs: [{ path: 'src/core.c', digest: d('core.c'), mode: 0o644 }],
    outputs: [{ path: 'build/core.o', digest: d('core.o@mac'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'execbit_script',
    observedAt: 3300,
    command: '/opt/toolchain/bin/bash',
    argv: ['scripts/package.sh'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin' },
    inputs: [{ path: 'scripts/package.sh', digest: d('package.sh'), mode: 0o755 }],
    outputs: [{ path: 'build/package.tar', digest: d('package.tar'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'execbit_script_noexec',
    observedAt: 3350,
    command: '/opt/toolchain/bin/bash',
    argv: ['scripts/package.sh'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin' },
    // same content, executable bit cleared -> semantic difference
    inputs: [{ path: 'scripts/package.sh', digest: d('package.sh'), mode: 0o644 }],
    outputs: [{ path: 'build/package.tar', digest: d('package.tar'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'symlink_pack',
    observedAt: 3400,
    command: '/opt/toolchain/bin/tar',
    argv: ['-cf', 'build/res.tar', 'res/link'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin' },
    inputs: [
      { path: 'res/link', digest: d('link-node'), mode: 0o777, symlinkTarget: 'versions/current' },
    ],
    outputs: [{ path: 'build/res.tar', digest: d('res.tar@current'), mode: 0o644 }],
    status: 'success',
  }),
  make({
    id: 'symlink_pack_other',
    observedAt: 3450,
    command: '/opt/toolchain/bin/tar',
    argv: ['-cf', 'build/res.tar', 'res/link'],
    cwd: '/home/ci/project',
    env: { PATH: '/usr/bin:/opt/toolchain/bin' },
    inputs: [
      // same node digest, symlink points elsewhere -> must not hit
      { path: 'res/link', digest: d('link-node'), mode: 0o777, symlinkTarget: 'versions/old' },
    ],
    outputs: [{ path: 'build/res.tar', digest: d('res.tar@old'), mode: 0o644 }],
    status: 'success',
  }),
]);

export const SEED_MANIFESTS: Manifest[] = [m1, m2, m3];

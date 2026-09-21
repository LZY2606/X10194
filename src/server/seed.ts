import { sha256 } from '../core/encoding';
import type { ActionManifest, ImportBatch, InputFile } from '../core/types';

const d = (s: string) => sha256(`seed:${s}`);

const file = (
  path: string,
  tag: string,
  extra: Partial<InputFile> = {},
): InputFile => ({
  path,
  algo: 'sha256',
  digest: d(tag),
  ...extra,
});

const linux = { os: 'linux', arch: 'amd64', libc: 'glibc-2.35' };

interface SeedOpts {
  /** 第二批是否故意乱序（依赖的动作还未导入） */
  outOfOrder?: boolean;
}

export function buildSeedBatches(opts: SeedOpts = {}): ImportBatch[] {
  // —— 批次 1：主 DAG（共享子图 + 失败节点）——
  const genHeader: ActionManifest = {
    id: 'gen_header',
    command: ['tools/gen-header.sh', '--out', 'build/config.h'],
    envWhitelist: ['CC', 'BUILD_ID'],
    envObserved: { CC: 'clang', BUILD_ID: '42', TERM: 'xterm' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('config/spec.yaml', 'spec-v3')],
    deps: [],
    outputs: [{ path: 'build/config.h', algo: 'sha256', digest: d('config.h') }],
  };

  const compileCore: ActionManifest = {
    id: 'compile_core',
    command: ['clang', '-c', 'src/core.c', '-o', 'build/core.o'],
    envWhitelist: ['CC', 'BUILD_ID', 'CFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', CFLAGS: '-O2', DEBUG: '1' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [
      file('src/core.c', 'core.c-v2'),
      file('build/config.h', 'config.h', { executable: false }),
    ],
    deps: ['gen_header'],
    outputs: [{ path: 'build/core.o', algo: 'sha256', digest: d('core.o') }],
  };

  const compileUtil: ActionManifest = {
    id: 'compile_util',
    command: ['clang', '-c', 'src/util.c', '-o', 'build/util.o'],
    envWhitelist: ['CC', 'BUILD_ID', 'CFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', CFLAGS: '-O2' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [
      file('src/util.c', 'util.c-v1'),
      file('build/config.h', 'config.h'),
    ],
    deps: ['gen_header'],
    outputs: [{ path: 'build/util.o', algo: 'sha256', digest: d('util.o') }],
  };

  const linkApp: ActionManifest = {
    id: 'link_app',
    command: ['clang', 'build/core.o', 'build/util.o', '-o', 'build/app'],
    envWhitelist: ['CC', 'BUILD_ID', 'LDFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', LDFLAGS: '' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('build/core.o', 'core.o'), file('build/util.o', 'util.o')],
    deps: ['compile_core', 'compile_util'],
    outputs: [{ path: 'build/app', algo: 'sha256', digest: d('app-v1') }],
  };

  const codegenProto: ActionManifest = {
    id: 'codegen_proto',
    command: ['tools/protoc-gen', '--in', 'api/app.proto'],
    envWhitelist: ['BUILD_ID'],
    envObserved: { BUILD_ID: '42' },
    toolchain: { name: 'protoc', version: '25.0', platform: linux },
    inputs: [file('api/app.proto', 'app.proto-v1')],
    deps: [],
    outputs: [],
    failed: true,
  };

  const compileGenerated: ActionManifest = {
    id: 'compile_generated',
    command: ['clang', '-c', 'build/app.pb.c', '-o', 'build/app.pb.o'],
    envWhitelist: ['CC', 'BUILD_ID'],
    envObserved: { CC: 'clang', BUILD_ID: '42' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('build/app.pb.c', 'app.pb.c')],
    deps: ['codegen_proto'],
    outputs: [{ path: 'build/app.pb.o', algo: 'sha256', digest: d('app.pb.o') }],
  };

  // 同键异输出（v0）：仅差白名单外环境 DEBUG —— 规则无法感知，假性命中
  const buildNightlyA: ActionManifest = {
    id: 'nightly_a',
    command: ['clang', 'build/core.o', 'build/util.o', '-o', 'build/nightly'],
    envWhitelist: ['CC', 'BUILD_ID', 'LDFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', LDFLAGS: '', NODE_NAME: 'node-a' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('build/core.o', 'core.o'), file('build/util.o', 'util.o')],
    deps: ['compile_core', 'compile_util'],
    outputs: [{ path: 'build/nightly', algo: 'sha256', digest: d('nightly-output-A') }],
  };

  const buildNightlyB: ActionManifest = {
    id: 'nightly_b',
    command: ['clang', 'build/core.o', 'build/util.o', '-o', 'build/nightly'],
    envWhitelist: ['CC', 'BUILD_ID', 'LDFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', LDFLAGS: '', NODE_NAME: 'node-b' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('build/core.o', 'core.o'), file('build/util.o', 'util.o')],
    deps: ['compile_core', 'compile_util'],
    outputs: [{ path: 'build/nightly', algo: 'sha256', digest: d('nightly-output-B') }],
  };

  // —— 规范化反例（v0 不同键；规则草案批准后变良性命中或暴露碰撞）——
  // 1) 路径分隔符
  const compileWinPath: ActionManifest = {
    id: 'compile_winpath',
    command: ['clang', '-c', 'src\\util.c', '-o', 'build/util_win.o'],
    envWhitelist: ['CC', 'BUILD_ID', 'CFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', CFLAGS: '-O2' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('src\\util.c', 'util.c-v1'), file('build/config.h', 'config.h')],
    deps: ['gen_header'],
    outputs: [{ path: 'build/util_win.o', algo: 'sha256', digest: d('util-win.o') }],
  };

  // 2) symlink 路径指向同一真实文件
  const compileSymlink: ActionManifest = {
    id: 'compile_symlink',
    command: ['clang', '-c', 'src/link_to_util.c', '-o', 'build/util_sl.o'],
    envWhitelist: ['CC', 'BUILD_ID', 'CFLAGS'],
    envObserved: { CC: 'clang', BUILD_ID: '42', CFLAGS: '-O2' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [
      file('src/link_to_util.c', 'util.c-v1', {
        isSymlink: true,
        symlinkTarget: 'src/util.c',
      }),
      file('build/config.h', 'config.h'),
    ],
    deps: ['gen_header'],
    outputs: [{ path: 'build/util_sl.o', algo: 'sha256', digest: d('util-sl.o') }],
  };

  // 3) 工作区别名 + 参数顺序（-I 声明为可交换且是路径标志）
  const buildAliasA: ActionManifest = {
    id: 'build_alias_a',
    command: ['clang', '-c', 'src/core.c', '-I', 'ws/src', '-I', 'ws/include', '-o', 'build/a.o'],
    envWhitelist: ['CC', 'BUILD_ID'],
    envObserved: { CC: 'clang', BUILD_ID: '42' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('src/core.c', 'core.c-v2'), file('ws/src/x.h', 'x.h')],
    deps: [],
    outputs: [{ path: 'build/a.o', algo: 'sha256', digest: d('alias-output') }],
  };
  const buildAliasB: ActionManifest = {
    id: 'build_alias_b',
    command: ['clang', '-c', 'src/core.c', '-I', 'ws/include', '-I', 'ws/src', '-o', 'build/b.o'],
    envWhitelist: ['CC', 'BUILD_ID'],
    envObserved: { CC: 'clang', BUILD_ID: '42' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('src/core.c', 'core.c-v2'), file('/workspace/src/x.h', 'x.h')],
    deps: [],
    outputs: [{ path: 'build/b.o', algo: 'sha256', digest: d('alias-output') }],
  };

  // 4) 语义差异对照组：可执行位不同 —— 规范化不能合并（碰撞反例）
  const buildScriptA: ActionManifest = {
    id: 'build_script_a',
    command: ['tools/run.sh', 'scripts/gen.py'],
    envWhitelist: ['CC', 'BUILD_ID'],
    envObserved: { CC: 'clang', BUILD_ID: '42' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('scripts/gen.py', 'gen.py-v1', { executable: true })],
    deps: [],
    outputs: [{ path: 'build/script_a.out', algo: 'sha256', digest: d('script-x') }],
  };
  const buildScriptB: ActionManifest = {
    id: 'build_script_b',
    command: ['tools/run.sh', 'scripts/gen.py'],
    envWhitelist: ['CC', 'BUILD_ID'],
    envObserved: { CC: 'clang', BUILD_ID: '42' },
    toolchain: { name: 'clang', version: '17.0.6', platform: linux },
    inputs: [file('scripts/gen.py', 'gen.py-v1', { executable: false })],
    deps: [],
    outputs: [{ path: 'build/script_b.out', algo: 'sha256', digest: d('script-nox') }],
  };

  const batch1: ImportBatch = {
    batchId: 'b-001',
    receivedAt: '2026-09-18T01:00:00.000Z',
    actions: [
      genHeader,
      compileCore,
      compileUtil,
      linkApp,
      codegenProto,
      compileGenerated,
      buildNightlyA,
      buildNightlyB,
    ],
  };

  const batch2: ImportBatch = {
    batchId: 'b-002',
    receivedAt: '2026-09-18T02:00:00.000Z',
    actions: [compileWinPath, compileSymlink],
  };

  const batch3: ImportBatch = {
    batchId: 'b-003',
    receivedAt: '2026-09-18T03:00:00.000Z',
    actions: [buildAliasA, buildAliasB, buildScriptA, buildScriptB],
  };

  // 批次 4：乱序导入 —— 依赖 sign_release 尚未到达
  const nightlyBundle: ActionManifest = {
    id: 'nightly_bundle',
    command: ['tools/bundle.sh', 'build/app', 'build/nightly'],
    envWhitelist: ['BUILD_ID'],
    envObserved: { BUILD_ID: '42' },
    toolchain: { name: 'bash', version: '5.2', platform: linux },
    inputs: [file('build/app', 'app-v1')],
    deps: ['link_app', 'sign_release'],
    outputs: [{ path: 'dist/app.tar.gz', algo: 'sha256', digest: d('app.tar.gz') }],
  };
  const signRelease: ActionManifest = {
    id: 'sign_release',
    command: ['tools/sign.sh', 'dist/app.tar.gz'],
    envWhitelist: ['BUILD_ID', 'SIGN_KEY'],
    envObserved: { BUILD_ID: '42', SIGN_KEY: 'ci-2026' },
    toolchain: { name: 'signify', version: '31', platform: linux },
    inputs: [file('dist/app.tar.gz', 'app.tar.gz')],
    deps: ['nightly_bundle'],
    outputs: [{ path: 'dist/app.tar.gz.sig', algo: 'sha256', digest: d('app.tar.gz.sig') }],
  };

  if (opts.outOfOrder) {
    return [
      batch1,
      batch2,
      batch3,
      { batchId: 'b-004', receivedAt: '2026-09-18T04:00:00.000Z', actions: [nightlyBundle] },
      { batchId: 'b-005', receivedAt: '2026-09-18T05:00:00.000Z', actions: [signRelease] },
    ];
  }
  return [
    batch1,
    batch2,
    batch3,
    {
      batchId: 'b-004',
      receivedAt: '2026-09-18T04:00:00.000Z',
      actions: [nightlyBundle, signRelease],
    },
  ];
}

/** 种子里故意写入的错误摘要：src/core.c 最初摘要有误，事后纠正 */
export const SEEDED_CORRECTION = {
  path: 'src/core.c',
  newAlgo: 'sha256',
  newDigest: d('core.c-v2-CORRECTED'),
  reason: '审计发现构建代理上的摘要器存在 off-by-one，重算后更正',
};

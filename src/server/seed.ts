// 演示种子：构建一个小型 C 工具链 DAG，覆盖全部指纹舱场景。
import type { Chamber } from './chamber';
import type { FileRecord, RawAction, RawManifest, RuleSet } from '../core/types';

const d = (s: string) => `sha256:${s.padEnd(8, '0').repeat(8)}`;

function file(path: string, digest: string, mode = 0o644, symlink?: FileRecord['symlink']): FileRecord {
  return { path, digest: d(digest), mode, symlink: symlink ?? null };
}

const clang = { name: 'clang', version: '17.0.6', path: '/opt/llvm/bin/clang' };
const linuxX64 = { os: 'linux', arch: 'x64', attributes: { libc: 'glibc-2.38' } };

function action(partial: Partial<RawAction> & Pick<RawAction, 'id' | 'command' | 'outputs'>): RawAction {
  return {
    cwd: '/home/user/proj',
    envWhitelist: ['CC', 'CFLAGS'],
    envObserved: { CC: 'clang', CFLAGS: '-O2' },
    toolchain: clang,
    platform: linuxX64,
    inputs: [],
    dependencies: [],
    failed: false,
    observedAt: '2026-09-20T10:00:00.000Z',
    ...partial,
  };
}

export function buildSeedManifest(): RawManifest {
  const actions: RawAction[] = [
    // 共享子图：a.c 与 b.c 都先经过同一份 codegen
    action({
      id: 'codegen-flatbuffers',
      command: ['python3', 'tools/codegen.py', '--schema', 'schema/flat.fbs'],
      inputs: [file('schema/flat.fbs', 'a1b2c3d4')],
      outputs: [file('build/gen/schema_generated.h', '1111aaaa')],
    }),
    action({
      id: 'compile-a',
      command: ['clang', '-c', 'src/a.c', '-O2', '-o', 'build/a.o'],
      inputs: [
        file('src/a.c', 'aaaa1111'),
        file('build/gen/schema_generated.h', '1111aaaa'),
      ],
      dependencies: ['codegen-flatbuffers'],
      outputs: [file('build/a.o', '2222bbbb')],
    }),
    action({
      id: 'compile-b',
      command: ['clang', '-c', 'src/b.c', '-O2', '-o', 'build/b.o'],
      inputs: [
        file('src/b.c', 'bbbb2222'),
        file('build/gen/schema_generated.h', '1111aaaa'),
      ],
      dependencies: ['codegen-flatbuffers'],
      outputs: [file('build/b.o', '3333cccc')],
    }),
    action({
      id: 'link-app',
      command: ['clang', 'build/a.o', 'build/b.o', '-o', 'build/app'],
      inputs: [file('build/a.o', '2222bbbb'), file('build/b.o', '3333cccc')],
      dependencies: ['compile-a', 'compile-b'],
      outputs: [file('build/app', '4444dddd', 0o755)],
    }),

    // 参数顺序：-j 顺序无关只有声明后才算等价（初始规则下两个动作 key 不同）
    action({
      id: 'ar-pack-early',
      command: ['ar', 'rcs', '-j', '4', 'build/lib.a', 'build/a.o'],
      inputs: [file('build/a.o', '2222bbbb')],
      dependencies: ['compile-a'],
      outputs: [file('build/lib.a', '5555eeee')],
    }),
    action({
      id: 'ar-pack-late',
      command: ['ar', 'rcs', '-j', '8', 'build/lib.a', 'build/a.o'],
      inputs: [file('build/a.o', '2222bbbb')],
      dependencies: ['compile-a'],
      outputs: [file('build/lib-alt.a', '5556eeee')],
    }),

    // 路径别名 + separator：同一次编译在 CI 容器与 Windows 挂载盘上的路径
    action({
      id: 'compile-a-ci',
      command: ['clang', '-c', 'src/a.c', '-O2', '-o', 'build/a-ci.o'],
      cwd: '/builds/team/proj',
      inputs: [file('src/a.c', 'aaaa1111'), file('build/gen/schema_generated.h', '1111aaaa')],
      dependencies: ['codegen-flatbuffers'],
      outputs: [file('build/a-ci.o', '2222bcbc')],
    }),
    action({
      id: 'compile-a-win',
      command: ['clang', '-c', 'src/a.c', '-O2', '-o', 'build/a-win.o'],
      cwd: 'C:\\work\\proj',
      inputs: [file('src\\a.c', 'aaaa1111'), file('build/gen/schema_generated.h', '1111aaaa')],
      dependencies: ['codegen-flatbuffers'],
      outputs: [file('build/a-win.o', '2222bdbd')],
    }),

    // symlink：同一路径指向不同真实目标，语义必须不同
    action({
      id: 'tool-wrapper-current',
      command: ['tools/tool', '--run'],
      inputs: [
        file('tools/tool', '7777aaaa', 0o777, { target: 'tool-v2.1/bin/tool', targetDigest: d('2121aaaa') }),
      ],
      outputs: [file('build/wrap-current.txt', '8888aaaa')],
    }),
    action({
      id: 'tool-wrapper-old',
      command: ['tools/tool', '--run'],
      inputs: [
        file('tools/tool', '7777aaaa', 0o777, { target: 'tool-v1.9/bin/tool', targetDigest: d('1919aaaa') }),
      ],
      outputs: [file('build/wrap-old.txt', '8888bbbb')],
    }),

    // 失败节点：依赖它的动作 key 钉入失败哨兵，而非普通结果版本
    action({
      id: 'gen-parser-fail',
      command: ['python3', 'tools/gen_parser.py'],
      inputs: [file('grammar/parser.gy', '9999aaaa')],
      outputs: [],
      failed: true,
      failureReason: 'grammar conflict at line 42',
    }),
    action({
      id: 'compile-parser-user',
      command: ['clang', '-c', 'build/parser.c', '-o', 'build/parser.o'],
      inputs: [file('build/parser.c', 'aaaa9999')],
      dependencies: ['gen-parser-fail'],
      outputs: [file('build/parser.o', 'bbbb9999')],
    }),

    // 未声明环境：BUILD_PARALLEL 不在白名单却出现
    action({
      id: 'custom-step-env',
      command: ['python3', 'tools/custom_step.py'],
      envWhitelist: ['CC'],
      envObserved: { CC: 'clang', BUILD_PARALLEL: '16', REMOTE_CACHE: 'eu-west' },
      inputs: [file('tools/custom_step.py', 'cccc8888')],
      outputs: [file('build/custom.out', 'dddd7777')],
    }),

    // 摘要纠错目标：src/a.c 的摘要后来被发现录错（compile-a 与 compile-a-ci 直接失信，下游 link-app 等可达失信）
    // 这里先以“旧摘要”存在，纠正通过 API 事件追加。
  ];

  return {
    manifestId: 'manifest-seed-001',
    importedAt: '2026-09-20T09:59:00.000Z',
    actions,
  };
}

/** 草案规则：只声明明确等价的部分，用于干跑演示。 */
export function buildCandidateRules(): RuleSet {
  return {
    pathAliases: [
      { from: '/home/user/proj', to: '<WORKSPACE>' },
      { from: '/builds/team/proj', to: '<WORKSPACE>' },
      { from: 'C:\\work\\proj', to: '<WORKSPACE>' },
    ],
    normalizeSeparators: true,
    unorderedFlags: ['-j'],
    envAliases: [],
    symlinkAliases: [],
    ignoreExecutableBit: false,
    ignoredPlatformAttributes: [],
  };
}

export function seedChamber(chamber: Chamber): void {
  const manifest = buildSeedManifest();
  chamber.importManifest(manifest);

  // 规则 v2 草案（不批准）：供 UI 干跑查看命中变化与碰撞反例
  chamber.createDraft(buildCandidateRules(), '草案 v2：工作区路径别名、分隔符折叠、ar -j 无序');

  // 缓存观察：compile-a 正常命中；link-app 出现同 key 异输出 -> 争议
  chamber.observeCacheEntry({
    actionId: 'compile-a',
    manifestId: manifest.manifestId,
    source: 'remote-cache/eu-west',
    observedAt: '2026-09-20T10:05:00.000Z',
  });
  chamber.observeCacheEntry({
    actionId: 'codegen-flatbuffers',
    manifestId: manifest.manifestId,
    source: 'remote-cache/us-east',
    observedAt: '2026-09-20T10:05:01.000Z',
  });
  // link-app：本地先看到正确产物，随后旧节点返回旧文件 -> 同 key 异输出争议
  chamber.observeCacheEntry({
    actionId: 'link-app',
    manifestId: manifest.manifestId,
    source: 'local-build',
    observedAt: '2026-09-20T10:06:00.000Z',
  });
  chamber.observeCacheEntry({
    actionId: 'link-app',
    manifestId: manifest.manifestId,
    source: 'remote-cache/eu-west (旧节点未清理)',
    observedAt: '2026-09-20T10:06:30.000Z',
    // 远端节点返回了旧版本产物：key 命中但内容不同 -> 争议，保留双方来源与首次观察顺序
    remoteOutputs: [file('build/app', '4444old0', 0o755)],
  });

  // 摘要纠错：src/a.c 摘要从 aaaa1111 的旧值纠正为真实值
  chamber.correctDigest({
    path: 'src/a.c',
    oldDigest: d('aaaa1111'),
    newDigest: d('aaaa1111-fix'),
    note: '事后审计发现摘要工具漏读文件尾，纠正 compile-a* 的输入摘要',
  });
}

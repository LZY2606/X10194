import { describe, expect, it } from 'vitest';
import {
  applyPathAliases,
  canonicalCommand,
  canonicalEnv,
  canonicalFile,
  canonicalPath,
  normalizeSeparators,
} from '../core/normalize';
import { action, makeRules } from './helpers';
import type { Transform } from '../core/types';

describe('路径 separator 规范化', () => {
  it('默认规则不动反斜杠', () => {
    const t: Transform[] = [];
    expect(canonicalPath('C:\\work\\proj\\a.c', makeRules(), t, 'x')).toBe('C:\\work\\proj\\a.c');
    expect(t).toHaveLength(0);
  });

  it('显式开启后才折叠为 /，并留下解释', () => {
    const t: Transform[] = [];
    const out = canonicalPath('C:\\work\\proj\\a.c', makeRules({ normalizeSeparators: true }), t, 'x');
    expect(out).toBe('C:/work/proj/a.c');
    expect(t[0].reason).toContain('分隔符');
  });

  it('normalizeSeparators 纯函数', () => {
    expect(normalizeSeparators('a\\b\\c')).toBe('a/b/c');
  });
});

describe('路径别名：长前缀优先', () => {
  it('更长的别名先命中', () => {
    const rules = makeRules({
      pathAliases: [
        { from: '/home/user', to: '<HOME>' },
        { from: '/home/user/proj', to: '<WS>' },
      ],
    });
    expect(applyPathAliases('/home/user/proj/a.c', rules.pathAliases).path).toBe('<WS>/a.c');
    expect(applyPathAliases('/home/user/other/a.c', rules.pathAliases).path).toBe('<HOME>/other/a.c');
  });
});

describe('命令参数：不随意全局排序', () => {
  it('未声明 -I 为无序时，-I 顺序变化导致命令不同', () => {
    const rules = makeRules();
    const a = canonicalCommand(['clang', '-I/aaa', '-I/bbb', 'x.c'], rules, []);
    const b = canonicalCommand(['clang', '-I/bbb', '-I/aaa', 'x.c'], rules, []);
    expect(a).not.toEqual(b);
  });

  it('声明 -j 无序后，仅其值排序，其它参数位置不动', () => {
    const rules = makeRules({ unorderedFlags: ['-j'] });
    const t: Transform[] = [];
    const out = canonicalCommand(['ar', 'rcs', '-j', '8', 'lib.a', 'a.o'], rules, t);
    // 单子项不重排
    expect(out).toEqual(['ar', 'rcs', '8', 'lib.a', 'a.o']);
    const t2: Transform[] = [];
    // 多值出现：收齐后排序
    const out2 = canonicalCommand(['ar', '-j', '8', '-j', '4', 'lib.a'], rules, t2);
    expect(out2).toEqual(['ar', '4', '8', 'lib.a']);
    expect(t2.some((x) => x.reason.includes('unorderedFlags'))).toBe(true);
  });

  it('支持 --jobs=N 与 -j8 内联形式', () => {
    const rules = makeRules({ unorderedFlags: ['--jobs'] });
    const out = canonicalCommand(['tool', '--jobs=8', '--jobs=4'], rules, []);
    expect(out).toEqual(['tool', '4', '8']);
  });
});

describe('环境缺失与未声明', () => {
  it('白名单变量缺失被显式记录，不补默认值', () => {
    const a = action({ id: 'a', envWhitelist: ['CC', 'CFLAGS'], envObserved: { CC: 'clang' } });
    const env = canonicalEnv(a, makeRules(), []);
    expect(env.canonical).toEqual({ CC: 'clang' });
    expect(env.missing).toEqual(['CFLAGS']);
  });

  it('未声明环境变量不进入指纹，但被报告', () => {
    const a = action({ id: 'a', envWhitelist: ['CC'], envObserved: { CC: 'clang', SECRET: '1' } });
    const env = canonicalEnv(a, makeRules(), []);
    expect(env.canonical).not.toHaveProperty('SECRET');
    expect(env.undeclared).toEqual(['SECRET']);
  });
});

describe('symlink 与可执行位', () => {
  it('symlink 目标进入文件指纹', () => {
    const t: Transform[] = [];
    const f1 = canonicalFile({ path: 't', digest: 'd', mode: 0o777, symlink: { target: 'v1/bin', targetDigest: 'x' } }, makeRules(), t);
    const f2 = canonicalFile({ path: 't', digest: 'd', mode: 0o777, symlink: { target: 'v2/bin', targetDigest: 'y' } }, makeRules(), t);
    expect(f1.symlink?.target).toBe('v1/bin');
    expect(JSON.stringify(f1)).not.toBe(JSON.stringify(f2));
  });

  it('只有显式开启 ignoreExecutableBit 才清除可执行位', () => {
    const strict = canonicalFile({ path: 't', digest: 'd', mode: 0o755, symlink: null }, makeRules(), []);
    const ignored = canonicalFile({ path: 't', digest: 'd', mode: 0o755, symlink: null }, makeRules({ ignoreExecutableBit: true }), []);
    expect(strict.mode).toBe(0o755);
    expect(ignored.mode).toBe(0o644);
  });
});

import { describe, expect, it } from 'vitest';
import { encodeList, frame, sha256 } from '../src/core/encoding';
import { normalizePath, normalizeEnv, normalizeCommand } from '../src/core/rules';
import { newVault, makeAction, batch, input, rule, fp } from './helpers';

describe('明确字节编码', () => {
  it('frame 带 utf8 字节长度，中日韩字符按字节计长', () => {
    const f = frame('构建');
    // 构/建 各 3 字节
    expect(f.toString('utf8').startsWith('6:')).toBe(true);
  });

  it('编码无分隔符歧义：["a b"] 与 ["a","b"] 摘要不同', () => {
    const one = sha256(encodeList(['a b']));
    const two = sha256(encodeList(['a', 'b']));
    expect(one).not.toBe(two);
  });

  it('长度前缀区分 ["1","23"] 与 ["12","3"]', () => {
    expect(sha256(encodeList(['1', '23']))).not.toBe(sha256(encodeList(['12', '3'])));
  });
});

describe('路径分隔符规范化（仅声明后生效）', () => {
  it('v0 不处理，反斜杠路径保留', () => {
    expect(normalizePath('src\\util.c', rule()).value).toBe('src\\util.c');
  });

  it('声明等价后统一为 /', () => {
    const r = rule({ normalizeSeparators: true });
    expect(normalizePath('src\\util.c', r).value).toBe('src/util.c');
  });

  it('v0 下仅分隔符不同的动作不命中；启用后命中（良性，输出相同）', () => {
    const vault = newVault();
    const a = makeAction({
      id: 'sep_a',
      command: ['clang', '-c', 'src/util.c'],
      inputs: [input('src/util.c', 'same-digest')],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'same-output' }],
    });
    const b = makeAction({
      id: 'sep_b',
      command: ['clang', '-c', 'src\\util.c'],
      inputs: [input('src\\util.c', 'same-digest')],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'same-output' }],
    });
    vault.importBatch(batch([a], 'sep-1'));
    vault.importBatch(batch([b], 'sep-2'));
    expect(fp(vault, 'sep_a').key).not.toBe(fp(vault, 'sep_b').key);

    const dry = vault.dryRun(rule({ normalizeSeparators: true, version: 1 }));
    expect(dry.newBenignHits.some((h) => h.actionIds.sort().join(',') === 'sep_a,sep_b')).toBe(true);
    expect(dry.collisions).toHaveLength(0);
  });
});

describe('symlink 目标', () => {
  it('未声明展开：symlink 事实与普通路径区分', () => {
    const vault = newVault();
    const a = makeAction({
      id: 'sl_a',
      inputs: [input('src/util.c', 'd')],
    });
    const b = makeAction({
      id: 'sl_b',
      inputs: [input('src/link.c', 'd', { isSymlink: true, symlinkTarget: 'src/util.c' })],
    });
    vault.importBatch(batch([a], 'sl-1'));
    vault.importBatch(batch([b], 'sl-2'));
    expect(fp(vault, 'sl_a').key).not.toBe(fp(vault, 'sl_b').key);
  });

  it('声明展开后：指向同一目标且摘要相同则命中；输出不同则给碰撞反例', () => {
    const vault = newVault();
    const a = makeAction({
      id: 'slx_a',
      inputs: [input('src/util.c', 'd')],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'out-same' }],
    });
    const b = makeAction({
      id: 'slx_b',
      inputs: [input('src/link.c', 'd', { isSymlink: true, symlinkTarget: 'src/util.c' })],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'out-same' }],
    });
    const c = makeAction({
      id: 'slx_c',
      inputs: [input('src/link2.c', 'd', { isSymlink: true, symlinkTarget: 'src/util.c' })],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'out-DIFFERENT' }],
    });
    vault.importBatch(batch([a, b, c], 'slx'));
    const dry = vault.dryRun(rule({ expandSymlinks: true, version: 1 }));
    expect(dry.newBenignHits.some((h) => h.actionIds.includes('slx_a') && h.actionIds.includes('slx_b'))).toBe(true);
    const collision = dry.collisions.find((cc) =>
      cc.outputGroups.some((g) => g.actionIds.includes('slx_c')),
    );
    expect(collision).toBeTruthy();
  });
});

describe('未声明环境与可执行位/平台', () => {
  it('白名单外环境不进 key，但产生风险注记', () => {
    const vault = newVault();
    const a = makeAction({ id: 'env_a', envObserved: { CC: 'clang' } });
    const b = makeAction({ id: 'env_b', envObserved: { CC: 'clang', SECRET: 'x' } });
    vault.importBatch(batch([a, b], 'env'));
    expect(fp(vault, 'env_a').key).toBe(fp(vault, 'env_b').key);
    const envComp = fp(vault, 'env_b').components.find((c) => c.tag === 'env')!;
    expect(envComp.notes.join(' ')).toContain('SECRET');
  });

  it('白名单变量缺失按空值计入并注记', () => {
    const { entries, notes } = normalizeEnv({ OTHER: '1' }, ['CC'], rule());
    expect(entries).toEqual(['CC=']);
    expect(notes.join(' ')).toContain('缺失');
  });

  it('可执行位差异不会被 symlink/路径规范化消除（仍是碰撞反例）', () => {
    const vault = newVault();
    const a = makeAction({
      id: 'xb_a',
      inputs: [input('s/gen.py', 'd', { executable: true })],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'ox' }],
    });
    const b = makeAction({
      id: 'xb_b',
      inputs: [input('s/gen.py', 'd', { executable: false })],
      outputs: [{ path: 'o', algo: 'sha256', digest: 'onox' }],
    });
    vault.importBatch(batch([a, b], 'xb'));
    const dry = vault.dryRun(rule({ normalizeSeparators: true, expandSymlinks: true, version: 1 }));
    expect(dry.collisions.some((c) => c.outputGroups.some((g) => g.actionIds.includes('xb_a')))).toBe(true);
  });

  it('平台属性不同不命中', () => {
    const vault = newVault();
    const a = makeAction({ id: 'pl_a', toolchain: { name: 'clang', version: '17', platform: { os: 'linux' } } });
    const b = makeAction({ id: 'pl_b', toolchain: { name: 'clang', version: '17', platform: { os: 'darwin' } } });
    vault.importBatch(batch([a, b], 'pl'));
    expect(fp(vault, 'pl_a').key).not.toBe(fp(vault, 'pl_b').key);
    expect(vault.compare('pl_a', 'pl_b').mismatchedTags).toContain('toolchain');
  });
});

describe('参数顺序：不随意排序', () => {
  it('默认不排序：-I 顺序不同则 key 不同', () => {
    const { canonical: c1 } = normalizeCommand(['clang', '-I', 'a', '-I', 'b'], rule());
    const { canonical: c2 } = normalizeCommand(['clang', '-I', 'b', '-I', 'a'], rule());
    expect(c1).not.toEqual(c2);
  });

  it('仅声明 -I 可交换且为路径标志后才排序并做路径规范化', () => {
    const r = rule({ commutativeFlags: ['-I'], pathFlags: ['-I'] });
    const { canonical, notes } = normalizeCommand(['clang', '-I', 'a', '-I', 'b'], r);
    expect(canonical).toEqual(normalizeCommand(['clang', '-I', 'b', '-I', 'a'], r).canonical);
    expect(notes.join(' ')).toContain('排序');
  });
});

import { describe, expect, it } from 'vitest';
import { ByteWriter, describeBytes, encodeValue, hashCanonical } from '../core/encoding';

describe('明确字节编码', () => {
  it('map 属性顺序不同但编码相同（键按 UTF-8 字节序排序）', () => {
    expect(hashCanonical({ a: '1', b: '2' })).toBe(hashCanonical({ b: '2', a: '1' }));
  });

  it('列表顺序不同编码不同', () => {
    expect(hashCanonical(['a', 'b'])).not.toBe(hashCanonical(['b', 'a']));
  });

  it('类型标签防止跨类型碰撞：字符串 "1" 与整数 1', () => {
    expect(hashCanonical('1')).not.toBe(hashCanonical(1));
    expect(hashCanonical(true)).not.toBe(hashCanonical(1));
    expect(hashCanonical(null)).not.toBe(hashCanonical(false));
  });

  it('嵌套结构：[] 与 {} 不碰撞', () => {
    expect(hashCanonical([])).not.toBe(hashCanonical({}));
  });

  it('所有 hash 输入走 UTF-8 明确字节（日文路径）', () => {
    const w = new ByteWriter();
    w.writeString('src/生成物/ソース.c');
    const described = describeBytes(w.bytes());
    expect(described).toContain('ソース.c');
    const w2 = new ByteWriter();
    encodeValue(w2, { path: 'src/生成物/ソース.c' });
    expect(w2.bytes().length).toBeGreaterThan('src/生成物/ソース.c'.length);
  });
});

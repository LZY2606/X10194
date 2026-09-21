import { describe, expect, it } from 'vitest';
import { concat, frame, kv, seq, sha256, u32be } from '../src/core/encode';

describe('explicit byte encoding', () => {
  it('length framing is unambiguous under concatenation', () => {
    const a = frame('k', 'ab');
    const b = frame('k', 'c');
    const joined = concat([a, b]);
    // "ab"+"c" must not hash equal to "abc" alone
    expect(sha256(joined)).not.toBe(sha256(frame('k', 'abc')));
  });

  it('sequences distinguish order (no implicit sort)', () => {
    const ab = sha256(seq(['a', 'b']));
    const ba = sha256(seq(['b', 'a']));
    expect(ab).not.toBe(ba);
  });

  it('encodes UTF-8 and uint32 length deterministically across runs', () => {
    const f = frame('标签', '値');
    const expectedLen = new TextEncoder().encode('値').length;
    const dv = new DataView(f.buffer);
    // tag, NUL, then uint32 BE length
    expect(dv.getUint32(bytesTagLen('标签') + 1)).toBe(expectedLen);
    expect(sha256(f)).toBe(sha256(f));
  });

  it('u32be is big-endian', () => {
    expect([...u32be(1)]).toEqual([0, 0, 0, 1]);
    expect([...u32be(256)]).toEqual([0, 0, 1, 0]);
  });

  it('kv pairs with same concat text but different keys never collide', () => {
    const x = sha256(concat([kv('ab', 'c'), kv('d', 'e')]));
    const y = sha256(concat([kv('a', 'bc'), kv('d', 'e')]));
    expect(x).not.toBe(y);
  });
});

function bytesTagLen(tag: string): number {
  return new TextEncoder().encode(tag).length;
}

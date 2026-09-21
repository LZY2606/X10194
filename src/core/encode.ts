import { createHash } from 'node:crypto';

/**
 * Every hash input goes through this explicit byte framing, so a digest is
 * reproducible byte-for-byte across machines and runs.
 *
 * frame(tag, payload):
 *   tag bytes (fixed-width ASCII, no NUL), 0x00
 *   uint32 BE payload length, payload bytes (UTF-8)
 *
 * seq(parts): each part framed with index:
 *   frame("item:" + i, part)
 */
export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function frame(tag: string, payload: string | Uint8Array): Uint8Array {
  if (tag.includes('\0')) throw new Error(`frame tag must not contain NUL: ${tag}`);
  const body = typeof payload === 'string' ? bytes(payload) : payload;
  return concat([bytes(tag), new Uint8Array([0]), u32be(body.length), body]);
}

export function item(index: number, payload: string | Uint8Array): Uint8Array {
  return frame(`item:${index}`, payload);
}

export function seq(parts: (string | Uint8Array)[]): Uint8Array {
  return concat(parts.map((p, i) => item(i, p)));
}

/** Stable string for a key-value list: frame("k", k) frame("v", v) */
export function kv(k: string, v: string | Uint8Array): Uint8Array {
  return concat([frame('k', k), frame('v', v)]);
}

export function sha256(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function hashFrame(tag: string, payload: string | Uint8Array): string {
  return sha256(frame(tag, payload));
}

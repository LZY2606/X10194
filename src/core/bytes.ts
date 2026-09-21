// 所有进入 hash 的数据都必须经过这里的明确字节编码与长度前缀分帧，
// 保证 "ab"+"c" 与 "a"+"bc" 永远不会产生相同的输入字节流。
import { createHash } from 'node:crypto';

const encoder = new TextEncoder(); // 固定 UTF-8

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// 单字段分帧: ASCII 十进制长度 + ':' + 原始字节
export function frameField(field: string | Uint8Array): Uint8Array {
  const bytes = typeof field === 'string' ? utf8(field) : field;
  return concat([utf8(String(bytes.length)), utf8(':'), bytes]);
}

// 结构分帧: 域标签 + 字段数 + 各字段(长度前缀)
export function frame(domain: string, fields: (string | Uint8Array)[]): Uint8Array {
  return concat([
    utf8('BFC1'),
    utf8('|'),
    frameField(domain),
    frameField(String(fields.length)),
    ...fields.map(frameField),
  ]);
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashFrame(domain: string, fields: (string | Uint8Array)[]): string {
  return sha256Hex(frame(domain, fields));
}

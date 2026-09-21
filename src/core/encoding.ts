// 明确字节编码：所有 hash 输入都经过 Encoder，杜绝 JSON.stringify/隐式 UTF-16 的歧义。
//
// 规则：
//  - 字符串：[0x01][utf8 字节][0x00]
//  - 整数（安全范围内）：[0x02][8 字节 big-endian]
//  - 布尔：[0x03] 表示 true，[0x04] 表示 false
//  - null/缺失：[0x05]
//  - 列表：[0x10][元素...][0x11]
//  - 记录/map：[0x12][键 tag + 值 tag ...（键按 UTF-8 字节序排序）][0x13]
// 标签保证不同类型/结构不会意外碰撞。

import { createHash } from 'node:crypto';

const T_STR = 0x01;
const T_INT = 0x02;
const T_TRUE = 0x03;
const T_FALSE = 0x04;
const T_NULL = 0x05;
const T_LIST_BEGIN = 0x10;
const T_LIST_END = 0x11;
const T_MAP_BEGIN = 0x12;
const T_MAP_END = 0x13;

const encoder = new TextEncoder();

export type HashFn = (bytes: Uint8Array) => string;

/** Node 环境默认 SHA-256（十六进制）。纯环境可注入其他实现（测试里也可换成可见编码）。 */
export const sha256: HashFn = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  writeTag(tag: number): this {
    this.push(new Uint8Array([tag]));
    return this;
  }

  writeString(value: string): this {
    const bytes = encoder.encode(value);
    const head = new Uint8Array(bytes.length + 2);
    head[0] = T_STR;
    head.set(bytes, 1);
    head[head.length - 1] = 0x00;
    this.push(head);
    return this;
  }

  writeInt(value: number): this {
    if (!Number.isSafeInteger(value)) throw new Error(`整数超出安全范围: ${value}`);
    const buf = new Uint8Array(9);
    buf[0] = T_INT;
    let v = BigInt(value);
    for (let i = 8; i >= 1; i--) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.push(buf);
    return this;
  }

  writeBool(value: boolean): this {
    return this.writeTag(value ? T_TRUE : T_FALSE);
  }

  writeNull(): this {
    return this.writeTag(T_NULL);
  }

  beginList(): this {
    return this.writeTag(T_LIST_BEGIN);
  }
  endList(): this {
    return this.writeTag(T_LIST_END);
  }
  beginMap(): this {
    return this.writeTag(T_MAP_BEGIN);
  }
  endMap(): this {
    return this.writeTag(T_MAP_END);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** 将任意规范值递归编码为明确字节。map 键按 UTF-8 字节序排序，消除属性顺序歧义。 */
export function encodeValue(writer: ByteWriter, value: CanonicalValue): void {
  if (value === null || value === undefined) {
    writer.writeNull();
  } else if (typeof value === 'string') {
    writer.writeString(value);
  } else if (typeof value === 'boolean') {
    writer.writeBool(value);
  } else if (typeof value === 'number') {
    writer.writeInt(value);
  } else if (Array.isArray(value)) {
    writer.beginList();
    for (const item of value) encodeValue(writer, item);
    writer.endList();
  } else if (typeof value === 'object') {
    writer.beginMap();
    const keys = Object.keys(value).sort((a, b) => {
      const ab = encoder.encode(a);
      const bb = encoder.encode(b);
      const n = Math.min(ab.length, bb.length);
      for (let i = 0; i < n; i++) if (ab[i] !== bb[i]) return ab[i] - bb[i];
      return ab.length - bb.length;
    });
    for (const key of keys) {
      writer.writeString(key);
      encodeValue(writer, value[key]);
    }
    writer.endMap();
  } else {
    throw new Error(`无法编码的值类型: ${typeof value}`);
  }
}

export function hashCanonical(value: CanonicalValue, hashFn: HashFn = sha256): string {
  const writer = new ByteWriter();
  encodeValue(writer, value);
  return hashFn(writer.bytes());
}

/** 便于调试/测试：把字节序列转成可读标签序列（不用于持久化）。 */
export function describeBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    if (tag === T_STR) {
      const start = i;
      while (i < bytes.length && bytes[i] !== 0x00) i++;
      parts.push(`s(${new TextDecoder().decode(bytes.slice(start, i))})`);
      i++;
    } else if (tag === T_INT) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(bytes[i + j]);
      i += 8;
      parts.push(`i(${v.toString()})`);
    } else {
      parts.push(`0x${tag.toString(16).padStart(2, '0')}`);
    }
  }
  return parts.join(' ');
}

// 明确字节编码：所有喂给哈希的内容都使用长度前缀，杜绝拼接歧义。
// 文本一律 UTF-8；hex 摘要先转原始字节；整数使用小端序变长编码。
import { createHash } from "node:crypto";

const utf8 = new TextEncoder();

export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private size = 0;

  private push(chunk: Uint8Array): this {
    this.chunks.push(chunk);
    this.size += chunk.length;
    return this;
  }

  /** 带类型标签，保证不同语义的同字节内容不会撞 */
  tag(label: string): this {
    const t = utf8.encode(label);
    this.varint(t.length).push(t);
    return this;
  }

  varint(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`varint 需要非负安全整数，收到 ${n}`);
    }
    const out: number[] = [];
    let rest = n;
    do {
      let b = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) b |= 0x80;
      out.push(b);
    } while (rest > 0);
    return this.push(Uint8Array.from(out));
  }

  bytes(data: Uint8Array): this {
    this.varint(data.length).push(data);
    return this;
  }

  text(value: string): this {
    return this.bytes(utf8.encode(value));
  }

  boolean(value: boolean): this {
    return this.push(Uint8Array.of(value ? 1 : 0));
  }

  /** 以规范 JSON 序列化后编码（键排序，无键则无空格） */
  json(value: unknown): this {
    return this.text(canonicalJson(value));
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  toHex(): string {
    return Buffer.from(this.toBytes()).toString("hex");
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return (
    "{" +
    entries
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
      .join(",") +
    "}"
  );
}

export function digestBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`非法 hex 摘要: ${JSON.stringify(hex.slice(0, 24))}`);
  }
  return new Uint8Array(Buffer.from(clean, "hex"));
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 组件字节编码统一入口：标签 + 值 */
export function componentBytes(label: string, encode: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter();
  w.tag(label);
  encode(w);
  return w.toBytes();
}

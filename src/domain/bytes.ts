import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export class ByteWriter {
  private chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    const length = new ArrayBuffer(4);
    new DataView(length).setUint32(0, value.length, false);
    this.chunks.push(new Uint8Array(length), value);
    return this;
  }

  text(value: string): this {
    this.bytes(encoder.encode(value));
    return this;
  }

  tag(value: string): this {
    this.text(value);
    return this;
  }

  boolean(value: boolean): this {
    this.bytes(new Uint8Array([value ? 1 : 0]));
    return this;
  }

  uint(value: number): this {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, BigInt(value), false);
    this.bytes(new Uint8Array(buffer));
    return this;
  }

  list<T>(values: T[], write: (writer: ByteWriter, value: T) => void): this {
    this.uint(values.length);
    for (const value of values) write(this, value);
    return this;
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

export function fingerprint(tag: string, build: (writer: ByteWriter) => void): string {
  const writer = new ByteWriter();
  writer.tag(tag);
  build(writer);
  return createHash("sha256").update(writer.toBytes()).digest("hex");
}

export function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

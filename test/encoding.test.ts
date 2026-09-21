import { describe, expect, it } from "vitest";
import { ByteWriter, canonicalJson, componentBytes, digestBytes, sha256Hex } from "../src/shared/encoding.ts";

describe("明确字节编码", () => {
  it("长度前缀消除拼接歧义（a+bc 与 ab+c 不同）", () => {
    const enc = (parts: string[]) => {
      const w = new ByteWriter();
      for (const p of parts) w.text(p);
      return w.toHex();
    };
    expect(enc(["a", "bc"])).not.toBe(enc(["ab", "c"]));
  });

  it("标签使不同语义的相同字节分离", () => {
    const a = componentBytes("command", (w) => w.text("clang"));
    const b = componentBytes("toolchain", (w) => w.text("clang"));
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });

  it("canonicalJson 键序稳定", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("非法 hex 摘要被拒绝", () => {
    expect(() => digestBytes("zz")).toThrow();
    expect(() => digestBytes("abc")).toThrow();
  });
});

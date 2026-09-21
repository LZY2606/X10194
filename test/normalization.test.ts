import { describe, expect, it } from "vitest";
import { DEFAULT_RULE, captureEnv, deriveKey, normalizePath } from "../src/shared/rules.ts";
import { action, aliasRule, hx } from "./helpers.ts";

const derive = (a: ReturnType<typeof action>, rule = DEFAULT_RULE) =>
  deriveKey(a, { rule, ruleVersionId: 1 });

describe("路径 separator 与别名", () => {
  it("默认规则不归一分隔符：C:\\sdk 与 /opt 路径各算各的", () => {
    const posix = action({ id: "p", inputs: [{ path: "/opt/sdk-v1/core.c", kind: "file", digest: hx("c"), mode: 0o644 }] });
    const win = action({ id: "w", inputs: [{ path: "C:\\sdk\\core.c", kind: "file", digest: hx("c"), mode: 0o644 }] });
    expect(derive(posix).key).not.toBe(derive(win).key);
  });

  it("显式开启 separator + 别名后两个前缀归一为同一 token", () => {
    const a = action({ id: "p", inputs: [{ path: "/opt/sdk-v1/core.c", kind: "file", digest: hx("c"), mode: 0o644 }] });
    const b = action({ id: "w", inputs: [{ path: "C:\\sdk\\core.c", kind: "file", digest: hx("c"), mode: 0o644 }] });
    expect(derive(a, aliasRule).key).toBe(derive(b, aliasRule).key);
    expect(normalizePath("/opt/sdk-v1/core.c", aliasRule).value).toBe("<SDK>/core.c");
  });

  it("最长前缀优先匹配", () => {
    const rule = {
      ...DEFAULT_RULE,
      pathAliases: [
        { prefix: "/opt/sdk", as: "OLD" },
        { prefix: "/opt/sdk-v1/sub", as: "SUB" },
      ],
    };
    expect(normalizePath("/opt/sdk-v1/sub/x.c", rule).value).toBe("<SUB>/x.c");
    expect(normalizePath("/opt/sdk/x.c", rule).value).toBe("<OLD>/x.c");
  });
});

describe("symlink 语义", () => {
  const linkA = action({
    id: "sa",
    inputs: [
      { path: "g.tbl", kind: "symlink", digest: hx("link-to-x"), target: "x", targetDigest: hx("content"), mode: 0o777 },
    ],
  });
  const linkB = action({
    id: "sb",
    inputs: [
      { path: "g.tbl", kind: "symlink", digest: hx("link-to-y"), target: "y", targetDigest: hx("content"), mode: 0o777 },
    ],
  });

  it("默认按链接字符串取证：目标相同但链接不同 -> miss", () => {
    expect(derive(linkA).key).not.toBe(derive(linkB).key);
  });

  it("显式 target-digest 规则：按目标内容取证 -> 同 key", () => {
    const rule = { ...DEFAULT_RULE, symlinkPolicy: "target-digest" as const };
    expect(derive(linkA, rule).key).toBe(derive(linkB, rule).key);
  });

  it("target-digest 缺少目标摘要时回退并告警", () => {
    const rule = { ...DEFAULT_RULE, symlinkPolicy: "target-digest" as const };
    const noTarget = action({
      id: "nt",
      inputs: [{ path: "g.tbl", kind: "symlink", digest: hx("link"), target: "x", mode: 0o777 }],
    });
    const d = derive(noTarget, rule);
    expect(d.warnings.join(" ")).toContain("回退");
  });
});

describe("环境变量", () => {
  it("未声明环境不进 key：CI_TOKEN 不同仍同 key，且产生风险提示", () => {
    const a = action({ id: "a", env: { CC: "clang", CI_TOKEN: "one" }, envWhitelist: ["CC"] });
    const b = action({ id: "b", env: { CC: "clang", CI_TOKEN: "two" }, envWhitelist: ["CC"] });
    expect(derive(a).key).toBe(derive(b).key);
    expect(captureEnv(a).undeclared).toEqual(["CI_TOKEN"]);
    expect(derive(a).warnings.join(" ")).toContain("CI_TOKEN");
  });

  it("白名单变量缺失按空值计入，且与显式空串等价但与有值不同", () => {
    const missing = action({ id: "m", env: {}, envWhitelist: ["CC", "BUILD_TYPE"] });
    const empty = action({ id: "e", env: { CC: "", BUILD_TYPE: "" }, envWhitelist: ["CC", "BUILD_TYPE"] });
    const valued = action({ id: "v", env: { CC: "clang", BUILD_TYPE: "" }, envWhitelist: ["CC", "BUILD_TYPE"] });
    expect(derive(missing).key).toBe(derive(empty).key);
    expect(derive(missing).key).not.toBe(derive(valued).key);
    expect(derive(missing).warnings.join(" ")).toContain("缺失");
  });
});

describe("参数顺序", () => {
  it("未声明可交换标志时不做全量排序：-D A -D B 与 -D B -D A 不同", () => {
    const a = action({ id: "a", args: ["-c", "x.c", "-D", "A", "-D", "B"] });
    const b = action({ id: "b", args: ["-c", "x.c", "-D", "B", "-D", "A"] });
    expect(derive(a).key).not.toBe(derive(b).key);
  });

  it("声明 -D 可交换后相邻单元排序：同 key", () => {
    const a = action({ id: "a", args: ["-c", "x.c", "-D", "A", "-D", "B"] });
    const b = action({ id: "b", args: ["-c", "x.c", "-D", "B", "-D", "A"] });
    expect(derive(a, aliasRule).key).toBe(derive(b, aliasRule).key);
  });

  it("位置参数不参与排序：子命令位置变化仍不同", () => {
    const rule = { ...DEFAULT_RULE, argCommutativeFlags: ["--opt"] };
    const a = action({ id: "a", args: ["build", "--opt", "1"] });
    const b = action({ id: "b", args: ["--opt", "1", "build"] });
    expect(derive(a, rule).key).not.toBe(derive(b, rule).key);
  });
});

describe("可执行位与平台", () => {
  it("可执行位默认计入指纹", () => {
    const a = action({ id: "a", inputs: [{ path: "s.c", kind: "file", digest: hx("s"), mode: 0o644 }] });
    const b = action({ id: "b", inputs: [{ path: "s.c", kind: "file", digest: hx("s"), mode: 0o755 }] });
    expect(derive(a).key).not.toBe(derive(b).key);
  });
  it("显式 ignoreMode 后同 key", () => {
    const a = action({ id: "a", inputs: [{ path: "s.c", kind: "file", digest: hx("s"), mode: 0o644 }] });
    const b = action({ id: "b", inputs: [{ path: "s.c", kind: "file", digest: hx("s"), mode: 0o755 }] });
    const rule = { ...DEFAULT_RULE, ignoreMode: true };
    expect(derive(a, rule).key).toBe(derive(b, rule).key);
  });
  it("平台默认计入，显式 ignorePlatform 后忽略", () => {
    const a = action({ id: "a", platform: { os: "darwin", arch: "arm64" } });
    const b = action({ id: "b", platform: { os: "linux", arch: "x64" } });
    expect(derive(a).key).not.toBe(derive(b).key);
    const rule = { ...DEFAULT_RULE, ignorePlatform: true };
    expect(derive(a, rule).key).toBe(derive(b, rule).key);
  });
});

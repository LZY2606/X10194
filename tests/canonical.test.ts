import { describe, expect, it } from "vitest";
import { computeAllFingerprints } from "../src/domain/canonical.js";
import type { RuleSet } from "../src/domain/types.js";
import { action, digest, input, manifest, strictRules } from "./helpers.js";

function keys(left: ReturnType<typeof action>, right: ReturnType<typeof action>, rules = strictRules) {
  const leftPrints = computeAllFingerprints("manifest-canonical", [left], rules);
  const rightPrints = computeAllFingerprints("manifest-canonical", [right], rules);
  return {
    left: leftPrints.get(left.id)!,
    right: rightPrints.get(right.id)!,
  };
}

describe("canonical fingerprint semantics", () => {
  it("keeps path separators semantically distinct unless an explicit rule equates them", () => {
    const slash = action("same-a", { id: "same", argv: ["-c", "/work/source.c"], inputs: [input("f", digest("same"), { path: "/work/f" })] });
    const back = action("same-b", { id: "same", argv: ["-c", "/work/source.c"], inputs: [input("f", digest("same"), { path: "\\work\\f", separator: "\\" })] });
    expect(keys(slash, back).left.key).not.toBe(keys(slash, back).right.key);
    const allowed: RuleSet = { ...strictRules, rules: [
      { id: "sep", scope: "separator", kind: "separatorAlias", tokenKind: "inputPath", from: "\\", to: "/", description: "explicit" },
    ]};
    const normalized = keys(slash, back, allowed);
    expect(normalized.left.key).toBe(normalized.right.key);
  });

  it("pins symlink targets and executable bits", () => {
    const base = action("symlink", { inputs: [input("f", digest("same"), { symlinkTarget: "/tmp/a" })] });
    const otherTarget = action("other-target", { inputs: [input("f", digest("same"), { symlinkTarget: "/tmp/b" })] });
    const nonExecutable = action("non-exec", { inputs: [input("f", digest("same"), { executable: false })] });
    const executable = action("exec", { inputs: [input("f", digest("same"), { executable: true })] });
    expect(keys(base, otherTarget).left.key).not.toBe(keys(base, otherTarget).right.key);
    expect(keys(nonExecutable, executable).left.key).not.toBe(keys(nonExecutable, executable).right.key);
  });

  it("encodes missing whitelisted environment and ignores undeclared environment", () => {
    const missing = action("missing", { envWhitelist: ["CC", "TARGET"], observedEnv: { CC: "clang" } });
    const present = action("present", { envWhitelist: ["CC", "TARGET"], observedEnv: { CC: "clang", TARGET: "x64" } });
    const secretA = action("same", { id: "same", argv: ["-c", "/same.c"], observedEnv: { CC: "clang", SECRET: "a" } });
    const secretB = action("same", { id: "same", argv: ["-c", "/same.c"], observedEnv: { CC: "clang", SECRET: "b" } });
    expect(keys(missing, present).left.key).not.toBe(keys(missing, present).right.key);
    expect(keys(secretA, secretB).left.key).toBe(keys(secretA, secretB).right.key);
  });

  it("never sorts arbitrary arguments; only an approved permutable group is reordered", () => {
    const a = action("same", { id: "same", argv: ["-Wall", "-Wextra", "src.c"] });
    const b = action("same", { id: "same", argv: ["-Wextra", "-Wall", "src.c"] });
    expect(keys(a, b).left.key).not.toBe(keys(a, b).right.key);
    const allowed: RuleSet = { ...strictRules, rules: [
      { id: "warnings", scope: "command", kind: "permutableFlagGroup", flags: ["-Wall", "-Wextra"], description: "warnings" },
    ]};
    expect(keys(a, b, allowed).left.key).toBe(keys(a, b, allowed).right.key);
  });

  it("pins platform attributes", () => {
    const linux = action("linux", { platform: { os: "linux", arch: "x64", shell: "bash" } });
    const darwin = action("darwin", { platform: { os: "darwin", arch: "arm64", shell: "zsh" } });
    expect(keys(linux, darwin).left.key).not.toBe(keys(linux, darwin).right.key);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { resetDb } from "../src/server/db.ts";
import type { Manifest, RawAction, RuleSpec } from "../src/shared/types.ts";

export function resetMemory(): void {
  resetDb(":memory:");
}

export function tempFileDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fpv-"));
  return path.join(dir, "test.db");
}

export function cleanupPath(file: string): void {
  rmSync(path.dirname(file), { recursive: true, force: true });
}

export function hx(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

export function action(partial: Partial<RawAction> & Pick<RawAction, "id">): RawAction {
  return {
    command: "clang",
    args: ["-c", "src.c"],
    envWhitelist: ["CC"],
    env: { CC: "clang" },
    toolchain: { name: "llvm", version: "17", path: "/usr/bin/clang" },
    platform: { os: "darwin", arch: "arm64" },
    inputs: [{ path: "src.c", kind: "file", digest: hx("src.c"), mode: 0o644 }],
    deps: [],
    outputs: [{ path: "out.o", kind: "file", digest: hx("out.o"), mode: 0o644 }],
    result: "success",
    ...partial,
  };
}

export function manifest(id: string, actions: RawAction[]): Manifest {
  return { manifestId: id, actions };
}

export const aliasRule: RuleSpec = {
  normalizePathSeparators: true,
  pathAliases: [
    { prefix: "/opt/sdk-v1", as: "SDK" },
    { prefix: "C:\\sdk", as: "SDK" },
  ],
  argCommutativeFlags: ["-D"],
  symlinkPolicy: "link",
  ignoreMode: false,
  ignorePlatform: false,
};

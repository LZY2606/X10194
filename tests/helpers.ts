import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { fingerprint } from "../src/domain/bytes.js";
import { openDatabase } from "../src/server/db.js";
import { VaultStore } from "../src/server/store.js";
import type { DatabaseSync } from "node:sqlite";
import type { ManifestImport, RawAction, RawInput, RuleSet } from "../src/domain/types.js";

let active: { path: string; db: DatabaseSync; store: VaultStore } | null = null;

afterEach(() => {
  if (!active) return;
  try { active.db.close(); } catch { /* already closed */ }
  rmSync(active.path, { recursive: true, force: true });
  active = null;
});

export function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "fingerprint-vault-"));
  const path = join(directory, "vault.sqlite");
  const db = openDatabase(path);
  const store = new VaultStore(db);
  active = { path, db, store };
  return { directory, path, db, store };
}

export function reopen(path: string) {
  const db = openDatabase(path);
  const store = new VaultStore(db);
  active = { path, db, store };
  return { db, store };
}

export function digest(label: string) {
  return fingerprint(label, (writer) => writer.text(label));
}

export function input(id: string, digestValue = digest(id), extra: Partial<RawInput> = {}): RawInput {
  return {
    id,
    path: `/${id}`,
    separator: "/",
    digest: digestValue,
    executable: false,
    ...extra,
  };
}

export function action(id: string, patch: Partial<RawAction> = {}): RawAction {
  return {
    id,
    command: "cc",
    argv: ["-c", `/${id}.c`],
    envWhitelist: ["CC"],
    observedEnv: { CC: "clang" },
    toolchain: { compiler: "clang" },
    platform: { os: "linux", arch: "x64", shell: "bash" },
    inputs: [input(`${id}.c`, digest(`input:${id}`))],
    dependencies: [],
    status: "succeeded",
    outputs: [{ path: `out/${id}.o`, digest: digest(`output:${id}`) }],
    ...patch,
  };
}

export function manifest(actions: RawAction[], id = `manifest-${digest(actions.map((item) => item.id).join(",")).slice(0, 8)}`): ManifestImport {
  return { id, importedAt: "2026-09-22T00:00:00.000Z", actions };
}

export const strictRules: RuleSet = { version: 0, status: "approved", rules: [] };

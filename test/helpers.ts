import Database from 'better-sqlite3';
import { VaultService } from '../src/server/vault';
import type { ActionManifest, InputFile, RuleSpec } from '../src/core/types';
import { DEFAULT_RULE } from '../src/core/rules';

export function newVault(): VaultService {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return new VaultService(db);
}

let counter = 0;
export const makeAction = (overrides: Partial<ActionManifest> & { id: string }): ActionManifest => ({
  command: ['clang', '-c', `${overrides.id}.c`],
  envWhitelist: ['CC'],
  envObserved: { CC: 'clang' },
  toolchain: { name: 'clang', version: '17', platform: { os: 'linux', arch: 'amd64' } },
  inputs: [],
  deps: [],
  outputs: [{ path: `out/${overrides.id}.o`, algo: 'sha256', digest: `out-${overrides.id}` }],
  ...overrides,
});

export const input = (path: string, digest = `dig-${path}`, extra: Partial<InputFile> = {}): InputFile => ({
  path,
  algo: 'sha256',
  digest,
  ...extra,
});

export const batch = (actions: ActionManifest[], batchId?: string) => ({
  batchId: batchId ?? `b${++counter}`,
  receivedAt: `2026-09-01T00:0${counter}:00.000Z`,
  actions,
});

export const rule = (overrides: Partial<RuleSpec> = {}): RuleSpec => ({
  ...DEFAULT_RULE,
  ...overrides,
});

export const fp = (vault: VaultService, id: string) => {
  const f = vault.repo.getFingerprint(id);
  if (!f) throw new Error(`fingerprint for ${id} missing`);
  return f;
};

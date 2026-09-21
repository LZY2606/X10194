import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chamber } from '../server/chamber';
import { defaultRules } from '../core/normalize';
import type { FileRecord, RawAction, RuleSet } from '../core/types';

export function makeChamber(): Chamber {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-test-'));
  return new Chamber(join(dir, 'db.sqlite'));
}

let counter = 0;
export function digest(seed: string): string {
  counter += 1;
  return `sha256:${seed}-${counter.toString(16)}`;
}

export function file(path: string, seed: string, mode = 0o644, symlink?: FileRecord['symlink']): FileRecord {
  return { path, digest: digest(seed), mode, symlink: symlink ?? null };
}

export function fixedFile(path: string, dgst: string, mode = 0o644, symlink?: FileRecord['symlink']): FileRecord {
  return { path, digest: dgst, mode, symlink: symlink ?? null };
}

export const TOOLCHAIN = { name: 'clang', version: '17.0.6', path: '/opt/llvm/bin/clang' };
export const PLATFORM = { os: 'linux', arch: 'x64', attributes: { libc: 'glibc-2.38' } };

export function action(partial: Partial<RawAction> & Pick<RawAction, 'id'>): RawAction {
  return {
    command: ['clang', '-c', 'src/x.c'],
    cwd: '/home/user/proj',
    envWhitelist: ['CC'],
    envObserved: { CC: 'clang' },
    toolchain: TOOLCHAIN,
    platform: PLATFORM,
    inputs: [],
    dependencies: [],
    outputs: [],
    failed: false,
    observedAt: `2026-09-20T10:${(counter % 60).toString().padStart(2, '0')}:00.000Z`,
    ...partial,
  };
}

export function manifest(id: string, actions: RawAction[], importedAt = '2026-09-20T09:00:00.000Z') {
  return { manifestId: id, importedAt, actions };
}

export function makeRules(partial: Partial<RuleSet> = {}): RuleSet {
  return { ...defaultRules(), ...partial };
}

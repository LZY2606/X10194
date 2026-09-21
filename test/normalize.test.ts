import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/core/fingerprint';
import type { NormalizationRule } from '../src/core/types';
import { spec } from './helpers';

const sepRule: NormalizationRule[] = [{ kind: 'pathSeparator', name: 'sep' }];
const aliasSepRules: NormalizationRule[] = [
  { kind: 'pathAlias', name: 'home', from: 'C:\\Users\\ci\\project', to: '/home/ci/project' },
  { kind: 'pathSeparator', name: 'sep' },
];

describe('path separator', () => {
  it('treats backslash and slash as different without a declared rule', () => {
    const unix = spec({ id: 'u', cwd: '/home/ci/project', inputs: [{ path: 'src/a.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }] });
    const win = spec({ id: 'w', cwd: 'C:\\Users\\ci\\project', inputs: [{ path: 'src\\a.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }], deps: [] });
    expect(fingerprint(unix, [], [], 1).key).not.toBe(fingerprint(win, [], [], 1).key);
  });

  it('makes declared separator + alias produce equal keys', () => {
    const unix = spec({ id: 'u', inputs: [{ path: 'src/a.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }] });
    const win = spec({
      id: 'w',
      cwd: 'C:\\Users\\ci\\project',
      inputs: [{ path: 'src\\a.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }],
    });
    expect(fingerprint(unix, [...aliasSepRules], [], 2).key).toBe(
      fingerprint(win, [...aliasSepRules], [], 2).key,
    );
  });

  it('records separator normalization in explain notes', () => {
    const win = spec({ id: 'w', inputs: [{ path: 'src\\a.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }] });
    const fp = fingerprint(win, [...sepRule], [], 2);
    const inputNote = fp.explain.inputs[0].notes.join();
    expect(inputNote).toContain('pathSeparator');
  });
});

describe('symlink target', () => {
  it('same node digest but different symlink target yields a different key', () => {
    const mk = (target: string, id: string) =>
      spec({ id, inputs: [{ path: 'res/link', digest: 'a'.padEnd(64, '0'), mode: 0o777, symlinkTarget: target }] });
    const a = fingerprint(mk('versions/current', 'a'), [], [], 1);
    const b = fingerprint(mk('versions/old', 'b'), [], [], 1);
    expect(a.key).not.toBe(b.key);
    const inp = a.explain.inputs[0];
    expect(inp.symlinkTarget).toBe('versions/current');
  });
});

describe('executable bit and platform', () => {
  it('mode change changes the key even with identical content digest', () => {
    const mk = (mode: number, id: string) =>
      spec({ id, inputs: [{ path: 'run.sh', digest: 's'.padEnd(64, '0'), mode }] });
    expect(fingerprint(mk(0o755, 'a'), [], [], 1).key).not.toBe(
      fingerprint(mk(0o644, 'b'), [], [], 1).key,
    );
  });

  it('platform os/arch is part of the fingerprint', () => {
    const linux = spec({ id: 'l', platform: { os: 'linux', arch: 'x64' } });
    const mac = spec({ id: 'm', platform: { os: 'darwin', arch: 'arm64' } });
    expect(fingerprint(linux, [], [], 1).key).not.toBe(fingerprint(mac, [], [], 1).key);
  });
});

describe('undeclared environment', () => {
  it('missing whitelist var differs from a present one', () => {
    const withCc = spec({ id: 'a', env: { PATH: '/usr/bin', CC: 'clang' } });
    const withoutCc = spec({ id: 'b', env: { PATH: '/usr/bin' } });
    expect(fingerprint(withCc, [], [], 1).key).not.toBe(fingerprint(withoutCc, [], [], 1).key);
  });

  it('an undeclared extra var is surfaced but whitelist equality governs identity', () => {
    const sameInputs = [{ path: 'src/main.c', digest: 'm'.padEnd(64, '0'), mode: 0o644 }];
    const clean = spec({ id: 'a', env: { PATH: '/usr/bin' }, inputs: sameInputs });
    const dirty = spec({ id: 'b', env: { PATH: '/usr/bin', SECRET: '1' }, inputs: sameInputs });
    const fpClean = fingerprint(clean, [], [], 1);
    const fpDirty = fingerprint(dirty, [], [], 1);
    expect(fpClean.key).toBe(fpDirty.key);
    expect(fpDirty.explain.env.find((e) => e.name === 'SECRET')?.declared).toBe(false);
  });
});

describe('argv ordering discipline', () => {
  it('never globally sorts arguments: source file order is preserved', () => {
    const ab = spec({ id: 'ab', argv: ['gcc', 'a.c', 'b.c'] });
    const ba = spec({ id: 'ba', argv: ['gcc', 'b.c', 'a.c'] });
    expect(fingerprint(ab, [], [], 1).key).not.toBe(fingerprint(ba, [], [], 1).key);
  });

  it('sorts only a declared unordered flag group and records it', () => {
    const mk = (argv: string[], id: string, inputs: { path: string; digest: string; mode: number }[]) =>
      spec({ id, argv, inputs });
    const rules: NormalizationRule[] = [{ kind: 'unorderedFlag', name: 'inc', flags: ['-I'] }];
    const xInputs = [{ path: 'src/x.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }];
    const a = fingerprint(mk(['-c', '-Ibuild', '-Ivendor', 'x.c'], 'a', xInputs), [...rules], [], 2);
    const b = fingerprint(mk(['-c', '-Ivendor', '-Ibuild', 'x.c'], 'b', xInputs), [...rules], [], 2);
    expect(a.key).toBe(b.key);
    const notes = [...a.explain.argv, ...b.explain.argv].flatMap((t) => t.notes).join();
    expect(notes).toContain('unorderedFlag');
    // unrelated positional args remain order-sensitive
    const yzInputs = [{ path: 'src/yz.c', digest: 'yz'.padEnd(64, '0'), mode: 0o644 }];
    const c = fingerprint(mk(['-c', '-Ibuild', '-Ivendor', 'y.c', 'z.c'], 'c', yzInputs), [...rules], [], 2);
    const d = fingerprint(mk(['-c', '-Ibuild', '-Ivendor', 'z.c', 'y.c'], 'd', yzInputs), [...rules], [], 2);
    expect(c.key).not.toBe(d.key);
  });

  it('handles separate flag/value tokens (-I build)', () => {
    const rules: NormalizationRule[] = [{ kind: 'unorderedFlag', name: 'inc', flags: ['-I'] }];
    const xInputs = [{ path: 'src/x.c', digest: 'x'.padEnd(64, '0'), mode: 0o644 }];
    const a = fingerprint(
      spec({ id: 'a', argv: ['-I', 'build', '-I', 'vendor', 'x.c'], inputs: xInputs }),
      [...rules],
      [],
      2,
    );
    const b = fingerprint(
      spec({ id: 'b', argv: ['-I', 'vendor', '-I', 'build', 'x.c'], inputs: xInputs }),
      [...rules],
      [],
      2,
    );
    expect(a.key).toBe(b.key);
  });
});

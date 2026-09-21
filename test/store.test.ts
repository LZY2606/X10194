import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store';
import type { ActionSpec, Manifest } from '../src/core/types';

let dir: string;
let dbPath: string;
let store: Store;

let seq = 0;
function dg(seed: string): string {
  seq += 1;
  let h = '';
  let x = 0;
  for (let i = 0; i < 64; i++) {
    x = (x * 31 + seed.charCodeAt(i % seed.length) + i * 7 + seq) >>> 0;
    h += (x % 16).toString(16);
  }
  return h;
}

interface MOpts {
  id: string;
  observedAt: number;
  deps?: string[];
  outputs?: Record<string, string>;
  inputs?: { path: string; digest: string; mode: number; symlinkTarget?: string | null }[];
  status?: 'success' | 'failed';
  argv?: string[];
  env?: Record<string, string>;
  whitelist?: string[];
}

function act(o: MOpts): ActionSpec {
  return {
    id: o.id,
    observedAt: o.observedAt,
    command: '/usr/bin/gcc',
    argv: o.argv ?? ['-c', `${o.id}.c`],
    cwd: '/home/ci/project',
    env: o.env ?? { PATH: '/usr/bin' },
    envWhitelist: o.whitelist ?? ['PATH'],
    toolchain: { name: 'gcc', version: '13.2' },
    platform: { os: 'linux', arch: 'x64' },
    inputs: o.inputs ?? [{ path: `${o.id}.c`, digest: dg(`${o.id}.c`), mode: 0o644 }],
    deps: o.deps ?? [],
    outputs: Object.entries(o.outputs ?? { [`${o.id}.o`]: dg(`${o.id}.o`) }).map(([path, digest]) => ({
      path,
      digest,
      mode: 0o644,
    })),
    status: o.status ?? 'success',
    exitCode: o.status === 'failed' ? 1 : 0,
    errorText: o.status === 'failed' ? 'fail' : null,
  };
}

function manifestOf(manifestId: string, actions: ActionSpec[], importedAt?: number): Manifest {
  return { manifestId, importedAt: importedAt ?? actions[0]?.observedAt ?? 0, actions };
}

function chunkImport(s: Store, manifest: Manifest, jobId?: string): string {
  const json = JSON.stringify(manifest);
  const id = jobId ?? `job:${manifest.manifestId}`;
  const size = 256;
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += size) chunks.push(json.slice(i, i + size));
  s.startImport(id, chunks.length);
  chunks.forEach((c, i) => s.putChunk(id, i, c));
  const ack = s.finalizeImport(id);
  return ack.manifestId!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bfv-'));
  dbPath = join(dir, 'vault.sqlite');
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function obsFor(actionId: string) {
  return store
    .listActions()
    .find((a) => a.actionId === actionId)!
    .observations.sort((x, y) => x.resultVersion - y.resultVersion);
}

describe('dependency sharing and failed-node pinning', () => {
  it('shared subgraph pins the same dependency result version for both dependents', () => {
    chunkImport(
      store,
      manifestOf('m1', [
        act({ id: 'gen', observedAt: 100 }),
        act({ id: 'left', observedAt: 200, deps: ['gen'] }),
        act({ id: 'right', observedAt: 300, deps: ['gen'] }),
      ]),
    );
    const left = obsFor('left')[0];
    const right = obsFor('right')[0];
    expect(left.pinned[0].resultVersion).toBe(right.pinned[0].resultVersion);
    // keys include the dep pin
    expect(store.compare(left.resultVersion, right.resultVersion).verdict).toBe('miss');
  });

  it('a new dependency output changes the pinned version, so the dependent misses', () => {
    chunkImport(store, manifestOf('m1', [act({ id: 'gen', observedAt: 100 }), act({ id: 'use', observedAt: 200, deps: ['gen'] })]));
    chunkImport(
      store,
      manifestOf('m2', [
        act({ id: 'gen', observedAt: 300, outputs: { 'gen.o': dg('gen-new') } }),
        act({ id: 'use', observedAt: 400, deps: ['gen'] }),
      ]),
    );
    const uses = obsFor('use');
    expect(uses).toHaveLength(2);
    expect(uses[0].pinned[0].resultVersion).not.toBe(uses[1].pinned[0].resultVersion);
    expect(uses[0].key).not.toBe(uses[1].key);
  });

  it('failed dep is pinned as a failed result and propagated failure keys miss', () => {
    chunkImport(
      store,
      manifestOf('m1', [
        act({ id: 'gen', observedAt: 100, status: 'failed', outputs: {} }),
        act({ id: 'use', observedAt: 200, deps: ['gen'], status: 'failed', outputs: {} }),
      ]),
    );
    const use = obsFor('use')[0];
    expect(use.pinned[0].status).toBe('failed');
    expect(use.status).toBe('failed');
    // failed observations never enter dispute aggregation
    expect(store.listDisputes()).toHaveLength(0);
  });
});

describe('digest correction distrust propagation', () => {
  it('only reachable actions lose trust, unrelated branches stay trusted', () => {
    chunkImport(
      store,
      manifestOf('m1', [
        act({ id: 'gen', observedAt: 100 }),
        act({ id: 'a1', observedAt: 200, deps: ['gen'] }),
        act({ id: 'a2', observedAt: 300, deps: ['a1'] }),
        act({ id: 'other', observedAt: 400 }),
      ]),
    );
    const genInput = `${'gen'}.c`;
    const bad = act({ id: 'gen', observedAt: 100 }).inputs[0].digest;
    const row = store.recordCorrection('gen', genInput, bad, dg('gen-fixed'));
    expect(row.affectedActions.sort()).toEqual(['a1', 'a2', 'gen']);
    const trusted = Object.fromEntries(store.listActions().map((a) => [a.actionId, a.trusted]));
    expect(trusted.gen).toBe(false);
    expect(trusted.a1).toBe(false);
    expect(trusted.a2).toBe(false);
    expect(trusted.other).toBe(true);
  });
});

describe('same key, different outputs -> dispute', () => {
  it('keeps both sources and first observation order, never last-write-wins', () => {
    const baseInputs = [{ path: 'f.c', digest: 'f'.padEnd(64, '0'), mode: 0o644 }];
    chunkImport(
      store,
      manifestOf('m1', [act({ id: 'x', observedAt: 100, inputs: baseInputs, outputs: { o: 'o1'.padEnd(64, '0') } })]),
    );
    chunkImport(
      store,
      manifestOf('m2', [act({ id: 'x', observedAt: 200, inputs: baseInputs, outputs: { o: 'o2'.padEnd(64, '0') } })]),
    );
    const disputes = store.listDisputes().filter((d) => d.status === 'open');
    expect(disputes).toHaveLength(1);
    const d = disputes[0];
    expect(d.firstOutputHash).not.toBe(d.secondOutputHash);
    expect(d.firstObservedAt).toBeLessThan(d.secondObservedAt);
    expect(d.firstManifestId).toBe('m1');
    expect(d.secondManifestId).toBe('m2');

    // a third agreeing-with-first observation must not overwrite either side
    chunkImport(
      store,
      manifestOf('m3', [act({ id: 'x', observedAt: 300, inputs: baseInputs, outputs: { o: 'o1'.padEnd(64, '0') } })]),
    );
    const again = store.listDisputes().filter((x) => x.status === 'open');
    expect(again).toHaveLength(1);
    expect(again[0].firstManifestId).toBe('m1');
    expect(again[0].secondManifestId).toBe('m2');
  });
});

describe('out-of-order import', () => {
  it('shuffled actions resolve deps by observedAt regardless of array order', () => {
    const actions = [
      act({ id: 'child', observedAt: 300, deps: ['parent'] }),
      act({ id: 'parent', observedAt: 200 }),
      act({ id: 'root', observedAt: 100 }),
      act({ id: 'parent2', observedAt: 250 }),
    ];
    chunkImport(store, manifestOf('m-shuffle', actions));
    const child = obsFor('child')[0];
    expect(child.pinned).toHaveLength(1);
    const parent = obsFor('parent')[0];
    expect(child.pinned[0].resultVersion).toBe(parent.resultVersion);
    const dag = store.getDag();
    expect(dag.edges.some((e) => e.from === 'child' && e.to === 'parent')).toBe(true);
  });

  it('importing the same content twice is deduplicated', () => {
    const m = manifestOf('m-dup', [act({ id: 'x', observedAt: 100 })]);
    chunkImport(store, m);
    chunkImport(store, { ...m, manifestId: 'm-dup-copy' });
    expect(obsFor('x')).toHaveLength(1);
  });
});

describe('crash recovery', () => {
  it('persists chunks and finalizes after reopen; partial derivation never survives', () => {
    const m = manifestOf('m-crash', [
      act({ id: 'p', observedAt: 100 }),
      act({ id: 'c', observedAt: 200, deps: ['p'] }),
    ]);
    const json = JSON.stringify(m);
    const jobId = 'job:crash';
    const size = 200;
    const chunks: string[] = [];
    for (let i = 0; i < json.length; i += size) chunks.push(json.slice(i, i + size));
    store.startImport(jobId, chunks.length);
    store.putChunk(jobId, 0, chunks[0]);
    // simulate crash before all chunks/finalize: drop process state, reopen DB
    store.close();
    expect(existsSync(dbPath)).toBe(true);
    store = new Store(dbPath);
    const job = store.listJobs().find((j) => j.jobId === jobId)!;
    expect(job.status).toBe('receiving');
    expect(job.receivedChunks).toBe(1);
    // no partial observations leaked
    expect(store.listActions()).toHaveLength(0);
    // resume with the remaining chunks and finalize
    for (let i = 1; i < chunks.length; i++) store.putChunk(jobId, i, chunks[i]);
    store.finalizeImport(jobId);
    expect(store.listActions().map((a) => a.actionId).sort()).toEqual(['c', 'p']);
    const child = obsFor('c')[0];
    expect(child.pinned[0].actionId).toBe('p');
  });

  it('rejects finalize with missing chunks', () => {
    const m = manifestOf('m-missing', [act({ id: 'p', observedAt: 100 })]);
    const json = JSON.stringify(m);
    const jobId = 'job:missing';
    const size = 100;
    const chunks: string[] = [];
    for (let i = 0; i < json.length; i += size) chunks.push(json.slice(i, i + size));
    store.startImport(jobId, chunks.length);
    store.putChunk(jobId, 0, chunks[0]);
    expect(() => store.finalizeImport(jobId)).toThrow(/分片不完整/);
  });
});

describe('rule versions: dry-run, approval, rollback', () => {
  it('dry-run reports hit gains and lets approval create a new version', () => {
    const inputs = [{ path: 'src/a.c', digest: 'a'.padEnd(64, '0'), mode: 0o644 }];
    chunkImport(
      store,
      manifestOf('m1', [
        act({ id: 'u1', observedAt: 100, argv: ['-c', '-Ibuild', '-Ivendor', 'src/a.c'], inputs, outputs: { o: 'same'.padEnd(64, '0') } }),
      ]),
    );
    chunkImport(
      store,
      manifestOf('m2', [
        act({ id: 'u3', observedAt: 300, argv: ['-c', '-Ivendor', '-Ibuild', 'src/a.c'], inputs, outputs: { o: 'same'.padEnd(64, '0') } }),
      ]),
    );
    const before = obsFor('u1')[0].key;
    const draft = store.createDraft('include 顺序等价', [
      { kind: 'unorderedFlag', name: 'inc', flags: ['-I'] },
    ]);
    const report = store.dryRunDraft(draft.version);
    expect(report.hitsGained).toBeGreaterThan(0);
    expect(report.collisions).toHaveLength(0);
    store.approveDraft(draft.version);
    expect(store.getActiveRules().version).toBe(draft.version);
    expect(obsFor('u1')[0].key).not.toBe(before);
  });

  it('flags a collision counter-example when a draft merges distinct outputs', () => {
    const inputs = [{ path: 'src/a.c', digest: 'a'.padEnd(64, '0'), mode: 0o644 }];
    chunkImport(
      store,
      manifestOf('m1', [
        act({ id: 'g1', observedAt: 100, argv: ['-c', '-Ibuild', '-Ivendor', 'src/a.c'], inputs, outputs: { o: dg('out-1') } }),
      ]),
    );
    chunkImport(
      store,
      manifestOf('m2', [
        act({ id: 'g2', observedAt: 200, argv: ['-c', '-Ivendor', '-Ibuild', 'src/a.c'], inputs, outputs: { o: dg('out-2') } }),
      ]),
    );
    const draft = store.createDraft('risky', [{ kind: 'unorderedFlag', name: 'inc', flags: ['-I'] }]);
    const report = store.dryRunDraft(draft.version);
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(report.collisions[0].counterexample).toContain('同键');
  });

  it('rollback restores v1 keys and is audited', () => {
    const inputs = [{ path: 'src/a.c', digest: 'a'.padEnd(64, '0'), mode: 0o644 }];
    chunkImport(
      store,
      manifestOf('m1', [act({ id: 'u', observedAt: 100, argv: ['-c', '-Ibuild', '-Ivendor', 'src/a.c'], inputs })]),
    );
    const v1Key = obsFor('u')[0].key;
    const draft = store.createDraft('inc', [{ kind: 'unorderedFlag', name: 'inc', flags: ['-I'] }]);
    store.approveDraft(draft.version);
    expect(obsFor('u')[0].key).not.toBe(v1Key);
    store.rollbackRule(1);
    expect(store.getActiveRules().version).toBe(1);
    expect(obsFor('u')[0].key).toBe(v1Key);
    expect(store.listAudit().some((e) => e.kind === 'rule_rollback')).toBe(true);
    // archived draft still exists, nothing was deleted
    expect(store.getRule(draft.version).status).toBe('archived');
  });
});

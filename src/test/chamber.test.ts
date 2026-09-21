import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chamber } from '../server/chamber';
import { action, fixedFile, makeChamber, makeRules, manifest } from './helpers';

describe('导入乱序与依赖共享', () => {
  it('依赖先于/后于消费方到达都能解析；共享子图只算一份', () => {
    const chamber = makeChamber();
    const gen = action({ id: 'gen', inputs: [fixedFile('g.in', 'gi')], outputs: [fixedFile('g.out', 'go')] });
    const a = action({ id: 'a', dependencies: ['gen'], inputs: [fixedFile('g.out', 'go')], outputs: [fixedFile('a.o', 'ao')] });
    const b = action({ id: 'b', dependencies: ['gen'], inputs: [fixedFile('g.out', 'go')], outputs: [fixedFile('b.o', 'bo')] });

    // 乱序：先到消费方 a/b，再到依赖 gen
    chamber.beginImport('m1', '2026-09-20T09:00:00.000Z', 3);
    chamber.importAction('m1', 0, a);
    chamber.importAction('m1', 1, b);
    let st = chamber.state();
    expect(st.fingerprints.find((f) => f.actionId === 'a')?.status).toBe('missing_dependency');
    chamber.importAction('m1', 2, gen);
    chamber.finishImport('m1');

    st = chamber.state();
    expect(st.fingerprints.find((f) => f.actionId === 'a')?.status).toBe('ok');
    expect(st.dag.sharedDeps).toContain('gen');
    expect(st.dag.edges.filter((e) => e.from === 'gen')).toHaveLength(2);
  });

  it('依赖始终缺失时保留未解析边', () => {
    const chamber = makeChamber();
    const a = action({ id: 'a', dependencies: ['ghost'] });
    chamber.importManifest(manifest('m', [a]));
    const st = chamber.state();
    expect(st.dag.edges.find((e) => e.dep === 'ghost')?.missing).toBe(true);
    expect(st.dag.nodes.find((n) => n.id === 'a')?.status).toBe('unresolved');
  });
});

describe('失败节点', () => {
  it('失败动作及其哨兵传播到 key', () => {
    const chamber = makeChamber();
    const fail = action({ id: 'fail', failed: true, failureReason: 'syntax error', outputs: [] });
    const use = action({ id: 'use', dependencies: ['fail'] });
    chamber.importManifest(manifest('m', [fail, use]));
    const fp = chamber.state().fingerprints.find((f) => f.actionId === 'use');
    expect(fp?.status).toBe('failed_dependency');
    expect(fp?.dependencyPins[0].outputVersion).toContain('failed:');
  });
});

describe('同键异输出 -> 争议', () => {
  it('两个缓存条目共用 key 却不同输出：进入争议，保留双方来源与首次观察顺序，绝不覆盖', () => {
    const chamber = makeChamber();
    const a = action({ id: 'a', outputs: [fixedFile('a.out', 'good')] });
    chamber.importManifest(manifest('m', [a]));
    chamber.observeCacheEntry({ actionId: 'a', manifestId: 'm', source: 'local', observedAt: '2026-01-01T00:00:01Z' });
    const result = chamber.observeCacheEntry({
      actionId: 'a',
      manifestId: 'm',
      source: 'remote-old-node',
      observedAt: '2026-01-01T00:00:02Z',
      remoteOutputs: [fixedFile('a.out', 'STALE')],
    });
    expect(result.dispute).not.toBeNull();
    const dispute = chamber.state().disputes[0];
    expect(dispute.status).toBe('open');
    expect(dispute.entries).toHaveLength(2);
    expect(dispute.entries[0].source).toBe('local');
    expect(dispute.entries[0].isFirst).toBe(true);
    expect(dispute.entries[1].source).toBe('remote-old-node');
    expect(dispute.firstResultVersion).toBe(dispute.entries[0].resultVersion);
    // 条目都还在，observedSeq 单调
    const entries = chamber.state().cacheEntries;
    expect(entries).toHaveLength(2);
    expect(entries[0].observedSeq).toBeLessThan(entries[1].observedSeq);
    expect(entries[0].resultVersion).not.toBe(entries[1].resultVersion);
  });

  it('同 key 同输出不产生争议', () => {
    const chamber = makeChamber();
    const a = action({ id: 'a', outputs: [fixedFile('a.out', 'good')] });
    chamber.importManifest(manifest('m', [a]));
    chamber.observeCacheEntry({ actionId: 'a', manifestId: 'm', source: 'local' });
    chamber.observeCacheEntry({ actionId: 'a', manifestId: 'm', source: 'remote' });
    expect(chamber.state().disputes).toHaveLength(0);
  });
});

describe('摘要纠正与失信传播', () => {
  it('只有消费错误摘要的动作及其可达下游失信，旁路不受影响', () => {
    const chamber = makeChamber();
    const gen = action({ id: 'gen', inputs: [fixedFile('shared.in', 'si')], outputs: [fixedFile('g.out', 'go')] });
    const a = action({ id: 'a', inputs: [fixedFile('x.c', 'WRONG')], dependencies: ['gen'], outputs: [fixedFile('a.o', 'ao')] });
    const b = action({ id: 'b', inputs: [fixedFile('y.c', 'other')], dependencies: ['gen'], outputs: [fixedFile('b.o', 'bo')] });
    const link = action({ id: 'link', dependencies: ['a'], outputs: [fixedFile('bin', 'bin')] });
    chamber.importManifest(manifest('m', [gen, a, b, link]));

    const prop = chamber.correctDigest({ path: 'x.c', oldDigest: 'WRONG', newDigest: 'FIXED' });
    expect(prop.directlyAffected).toEqual(['a']);
    expect(prop.reachable.map((r) => r.actionId)).toEqual(['link']);

    const st = chamber.state();
    const fpA = st.fingerprints.find((f) => f.actionId === 'a')!;
    const fpB = st.fingerprints.find((f) => f.actionId === 'b')!;
    const fpGen = st.fingerprints.find((f) => f.actionId === 'gen')!;
    const fpLink = st.fingerprints.find((f) => f.actionId === 'link')!;
    expect(fpA.distrusted).toBe(true);
    expect(fpLink.distrusted).toBe(true);
    expect(fpB.distrusted).toBe(false);
    expect(fpGen.distrusted).toBe(false);
    // 重算后 a 的 inputs 组件摘要为新值
    const inputsComponent = JSON.stringify(fpA.components.find((c) => c.name === 'inputs')?.canonical);
    expect(inputsComponent).toContain('FIXED');
    expect(inputsComponent).not.toContain('WRONG');
  });

  it('对旧摘要值不匹配的纠正不会误伤（oldDigest 必须吻合）', () => {
    const chamber = makeChamber();
    const a = action({ id: 'a', inputs: [fixedFile('x.c', 'actual')] });
    chamber.importManifest(manifest('m', [a]));
    const prop = chamber.correctDigest({ path: 'x.c', oldDigest: 'something-else', newDigest: 'FIXED' });
    expect(prop.directlyAffected).toEqual([]);
    expect(chamber.state().fingerprints[0].distrusted).toBe(false);
  });
});

describe('规则草案干跑、批准与回滚', () => {
  it('干跑报告 key 变化与碰撞反例；批准后生效；回滚生成新版本且历史保留', () => {
    const chamber = makeChamber();
    const a1 = action({ id: 'a1', cwd: '/home/user/proj', inputs: [fixedFile('x.c', 'same')], outputs: [fixedFile('a1.o', 'o1')] });
    const a2 = action({ id: 'a2', cwd: '/builds/team/proj', inputs: [fixedFile('x.c', 'same')], outputs: [fixedFile('a2.o', 'o2')] });
    chamber.importManifest(manifest('m', [a1, a2]));

    const before = chamber.state();
    expect(before.fingerprints.find((f) => f.actionId === 'a1')?.key)
      .not.toBe(before.fingerprints.find((f) => f.actionId === 'a2')?.key);

    const draftId = chamber.createDraft(
      makeRules({ pathAliases: [{ from: '/home/user/proj', to: '<WS>' }, { from: '/builds/team/proj', to: '<WS>' }] }),
      'cwd 别名',
    );
    const dry = chamber.dryRunDraft(draftId);
    expect(dry.changedCount).toBe(2);
    // a1/a2 折叠到同一 key，但输出不同 -> 碰撞反例
    const collision = dry.collisions.find((c) => c.actionIds.includes('a1') && c.actionIds.includes('a2'));
    expect(collision).toBeTruthy();
    expect(collision!.sameOutputs).toBe(false);

    chamber.approveDraft(draftId);
    const after = chamber.state();
    expect(after.activeRuleVersionId).toBe(draftId);
    expect(after.fingerprints.find((f) => f.actionId === 'a1')?.key)
      .toBe(after.fingerprints.find((f) => f.actionId === 'a2')?.key);

    const newId = chamber.rollbackTo(1);
    const versions = chamber.ruleVersions();
    expect(versions.find((v) => v.id === 1)).toBeTruthy(); // 历史保留
    expect(chamber.activeRuleVersion().id).toBe(newId);
    const rolled = chamber.state();
    expect(rolled.fingerprints.find((f) => f.actionId === 'a1')?.key)
      .not.toBe(rolled.fingerprints.find((f) => f.actionId === 'a2')?.key);
  });
});

describe('崩溃后恢复', () => {
  it('逐行动作提交：进程崩溃后已提交动作保留，清单标记 pending，可补齐', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chamber-crash-'));
    const dbPath = join(dir, 'db.sqlite');
    const c1 = new Chamber(dbPath);
    c1.beginImport('m', '2026-09-20T09:00:00.000Z', 3);
    c1.importAction('m', 0, action({ id: 'a', outputs: [fixedFile('a.o', 'a')] }));
    c1.importAction('m', 1, action({ id: 'b', outputs: [fixedFile('b.o', 'b')] }));
    // 模拟崩溃：没有 finish，没有第三条
    c1.db.close();

    const c2 = new Chamber(dbPath);
    const pending = c2.recoveryStatus();
    expect(pending).toEqual([{ manifestId: 'm', total: 3, done: 2 }]);

    // 补齐第三条并完成，重复投递前两条应幂等不报错
    c2.importAction('m', 0, action({ id: 'a', outputs: [fixedFile('a.o', 'a')] }));
    c2.importAction('m', 2, action({ id: 'c', dependencies: ['a'], inputs: [fixedFile('a.o', 'a')] }));
    c2.finishImport('m');
    const st = c2.state();
    expect(st.actions.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    expect(st.imports[0].pending).toBe(false);
    expect(st.fingerprints.find((f) => f.actionId === 'c')?.status).toBe('ok');
  });
});

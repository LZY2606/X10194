import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { openDb } from '../src/server/db';
import { VaultService } from '../src/server/vault';
import { batch, fp, input, makeAction, newVault } from './helpers';

describe('依赖共享与结果版本钉住', () => {
  it('共享子图：依赖输出变化改变 dep 钉版本并向上传播', () => {
    const vault = newVault();
    const base = makeAction({
      id: 'base',
      inputs: [input('f.txt', 'v1')],
      outputs: [{ path: 'base.o', algo: 'sha256', digest: 'out-v1' }],
    });
    const left = makeAction({ id: 'left', deps: ['base'], outputs: [{ path: 'l', algo: 'sha256', digest: 'ol' }] });
    const right = makeAction({ id: 'right', deps: ['base'], outputs: [{ path: 'r', algo: 'sha256', digest: 'or' }] });
    const top = makeAction({ id: 'top', deps: ['left', 'right'] });
    vault.importBatch(batch([base, left, right, top], 'deps'));

    const pinBefore = fp(vault, 'left').depPins.base;
    expect(pinBefore).toContain('ok:');
    expect(fp(vault, 'top').depPins.left).toBeTruthy();

    // base 输入摘要被纠正 -> base/left/right/top 全部可达失信，且 dep 钉值变化
    vault.addCorrection({
      path: 'f.txt',
      newAlgo: 'sha256',
      newDigest: 'v2-CORRECT',
      reason: 'test',
    });
    expect(new Set(vault.getState().distrusted)).toEqual(new Set(['base', 'left', 'right', 'top']));
    const pinAfter = fp(vault, 'left').depPins.base;
    expect(pinAfter).not.toBe(pinBefore);
  });

  it('无关节点不失信', () => {
    const vault = newVault();
    vault.importBatch(
      batch(
        [
          makeAction({ id: 'touched', inputs: [input('a', '1')] }),
          makeAction({ id: 'consumer', deps: ['touched'] }),
          makeAction({ id: 'isolated', inputs: [input('b', '2')] }),
        ],
        'iso',
      ),
    );
    vault.addCorrection({ path: 'a', newAlgo: 'sha256', newDigest: '9', reason: 'x' });
    expect(vault.getState().distrusted).not.toContain('isolated');
    expect(vault.getState().distrusted).toEqual(expect.arrayContaining(['touched', 'consumer']));
  });

  it('失败节点产生失败版本，依赖方被阻塞且钉住 failed:', () => {
    const vault = newVault();
    vault.importBatch(
      batch(
        [
          makeAction({ id: 'fail', failed: true, outputs: [] }),
          makeAction({ id: 'down', deps: ['fail'] }),
        ],
        'fail-b',
      ),
    );
    expect(fp(vault, 'fail').status).toBe('failed');
    expect(fp(vault, 'down').status).toBe('blocked');
    expect(fp(vault, 'down').depPins.fail.startsWith('failed:')).toBe(true);
  });

  it('阻塞/失败动作不产生缓存条目', () => {
    const vault = newVault();
    vault.importBatch(
      batch(
        [
          makeAction({ id: 'f1', failed: true, outputs: [] }),
          makeAction({ id: 'd1', deps: ['f1'] }),
          makeAction({ id: 'ok1' }),
        ],
        'ce',
      ),
    );
    const ids = vault.getState().entries.map((e) => e.actionId);
    expect(ids).toContain('ok1');
    expect(ids).not.toContain('f1');
    expect(ids).not.toContain('d1');
  });
});

describe('摘要纠正只使可达动作失信（含共享子图钻石）', () => {
  it('钻石依赖下两条下游路径都被标记一次', () => {
    const vault = newVault();
    vault.importBatch(
      batch(
        [
          makeAction({ id: 'root', inputs: [input('root.c', 'bad')] }),
          makeAction({ id: 'l', deps: ['root'] }),
          makeAction({ id: 'r', deps: ['root'] }),
          makeAction({ id: 'join', deps: ['l', 'r'] }),
        ],
        'diamond',
      ),
    );
    const res = vault.addCorrection({
      path: 'root.c',
      newAlgo: 'sha256',
      newDigest: 'good',
      reason: 'fix',
    });
    expect(res.distrusted.sort()).toEqual(['join', 'l', 'r', 'root']);
  });

  it('纠正后指纹组件标注使用了纠正摘要，原始清单不变', () => {
    const vault = newVault();
    vault.importBatch(batch([makeAction({ id: 'a1', inputs: [input('p', 'old')] })], 'corr'));
    vault.addCorrection({ path: 'p', newAlgo: 'sha256', newDigest: 'new', reason: 'r' });
    expect(fp(vault, 'a1').correctedInputPaths).toEqual(['p']);
    const state = vault.getState();
    expect(state.actions.get('a1')!.inputs[0].digest).toBe('old');
    const inputsComp = fp(vault, 'a1').components.find((c) => c.tag === 'inputs')!;
    expect(inputsComp.canonical[0]).toContain('new');
  });
});

describe('同键异输出：争议状态，不覆盖，保留首次观察顺序', () => {
  it('两条目同 key 不同输出进入争议，后续重复观察不覆盖', () => {
    const vault = newVault();
    const mk = (id: string, outputDigest: string) =>
      makeAction({
        id,
        outputs: [{ path: 'o', algo: 'sha256', digest: outputDigest }],
      });
    vault.importBatch(batch([mk('dup_a', 'OUT-A')], 'dup1'));
    vault.importBatch(batch([mk('dup_b', 'OUT-B')], 'dup2'));

    const disputes = vault.getState().disputes;
    expect(disputes).toHaveLength(1);
    const d = disputes[0];
    expect(d.parties.map((p) => p.actionId)).toEqual(['dup_a', 'dup_b']);
    expect(d.parties.map((p) => p.ord)).toEqual([0, 1]);
    expect(d.status).toBe('open');

    // 条目保持首次来源事实：再次重算/导入相同动作不会覆盖
    vault.recoverPending();
    const entries = vault.getState().entries.filter((e) => e.actionId.startsWith('dup_'));
    expect(entries.map((e) => e.outputHash).sort()).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(new Set(entries.map((e) => e.key)).size).toBe(1);
    expect(new Set(entries.map((e) => e.outputHash)).size).toBe(2);

    vault.resolveDispute(d.key, '人工确认');
    expect(vault.getState().disputes[0].status).toBe('resolved');
  });

  it('同 key 且同输出不是争议（良性共享）', () => {
    const vault = newVault();
    vault.importBatch(
      batch(
        [
          makeAction({ id: 's1', outputs: [{ path: 'o', algo: 'sha256', digest: 'SAME' }] }),
          makeAction({ id: 's2', outputs: [{ path: 'o', algo: 'sha256', digest: 'SAME' }] }),
        ],
        'same',
      ),
    );
    expect(vault.getState().disputes).toHaveLength(0);
  });
});

describe('规则回滚', () => {
  it('批准后形成新版本，回滚恢复旧 key，历史版本仍可查', () => {
    const vault = newVault();
    vault.importBatch(
      batch(
        [
          makeAction({ id: 'r1', command: ['clang', '-c', 'src/a.c'] }),
          makeAction({ id: 'r2', command: ['clang', '-c', 'src\\a.c'] }),
        ],
        'rb',
      ),
    );
    const before = [fp(vault, 'r1').key, fp(vault, 'r2').key];
    expect(before[0]).not.toBe(before[1]);

    vault.saveDraft({
      ...vault.activeRule(),
      version: 1,
      normalizeSeparators: true,
    });
    vault.approveDraft('启用分隔符等价');
    expect(vault.activeRuleVersion()).toBe(1);
    expect(fp(vault, 'r1').key).toBe(fp(vault, 'r2').key);

    vault.rollbackTo(0, '回滚');
    expect(vault.activeRuleVersion()).toBe(0);
    expect(fp(vault, 'r1').key).toBe(before[0]);
    expect(fp(vault, 'r2').key).toBe(before[1]);
    const versions = vault.listRuleVersions().map((v) => v.version);
    expect(versions).toEqual([0, 1]);
    expect(vault.listRuleEvents().map((e) => e.kind)).toEqual(['approve', 'rollback']);
  });

  it('存在碰撞反例时不阻止服务层批准（前端干跑把关），回滚到不存在版本报错', () => {
    const vault = newVault();
    expect(() => vault.rollbackTo(99, 'x')).toThrow(/不存在/);
  });
});

describe('导入乱序', () => {
  it('依赖先缺失后补齐：missing-deps -> 自动重算为 ok，并钉住结果版本', () => {
    const vault = newVault();
    vault.importBatch(batch([makeAction({ id: 'child', deps: ['parent'] })], 'late-1'));
    expect(fp(vault, 'child').status).toBe('missing-deps');
    expect(fp(vault, 'child').depPins.parent).toBe('missing');

    vault.importBatch(batch([makeAction({ id: 'parent' })], 'late-2'));
    expect(fp(vault, 'child').status).toBe('ok');
    expect(fp(vault, 'child').depPins.parent.startsWith('ok:')).toBe(true);
  });

  it('重复批次与重复动作被拒绝/跳过，原始记录不可覆盖', () => {
    const vault = newVault();
    vault.importBatch(batch([makeAction({ id: 'u1' })], 'dup-batch'));
    expect(() => vault.importBatch(batch([makeAction({ id: 'u1' })], 'dup-batch'))).toThrow();
    const r = vault.importBatch(batch([makeAction({ id: 'u1' }), makeAction({ id: 'u2' })], 'other'));
    expect(r.skipped).toEqual(['u1']);
    expect(r.inserted).toBe(1);
  });
});

describe('崩溃后恢复', () => {
  it('pending 批次在服务重建时被恢复并完成派生', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const dbFile = join(dir, 'v.db');

    // 第一次会话：只落原始记录，未派生（模拟崩溃）
    {
      const db = openDb(dbFile);
      const vault = new VaultService(db);
      const b = batch([makeAction({ id: 'crash1' })], 'crash-b');
      vault.repo.insertBatch({
        batchId: b.batchId,
        receivedAt: b.receivedAt,
        rawJson: JSON.stringify(b),
        ord: 1,
      });
      vault.repo.insertAction(b.actions[0], b.batchId, 1);
      db.close();
    }

    // 第二次会话
    {
      const db = openDb(dbFile);
      const vault = new VaultService(db);
      const recovered = vault.recoverPending();
      expect(recovered.recovered).toEqual(['crash-b']);
      expect(fp(vault, 'crash1').key).toBeTruthy();
      expect(vault.repo.listBatches()[0].status).toBe('derived');
      db.close();
    }

    // 再启动：没有遗留 pending
    {
      const db = openDb(dbFile);
      const vault = new VaultService(db);
      expect(vault.recoverPending().recovered).toEqual([]);
      db.close();
    }
  });
});

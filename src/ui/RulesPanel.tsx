import { useEffect, useState } from 'react';
import { client, type ApiState, type DryRun } from './api';
import type { RuleSpec } from '../core/types';

export function RulesPanel({
  state,
  notify,
  onChanged,
}: {
  state: ApiState;
  notify: (msg: string, error?: boolean) => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<RuleSpec>(state.draft);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => setDraft(state.draft), [state.draft]);

  const patch = (p: Partial<RuleSpec>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    try {
      const saved = await client.saveDraft(draft);
      setDraft(saved);
      notify('草案已保存（尚未生效）');
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const runDry = async () => {
    try {
      setDry(await client.dryRun(draft));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const approve = async () => {
    try {
      const r = await client.approve(note || '批准规则草案');
      notify(`已形成新规则版本 v${r.version} 并对全部历史动作重算`);
      setNote('');
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const rollback = async (version: number) => {
    try {
      await client.rollback(version, '界面发起回滚');
      notify(`已回滚到规则 v${version}`);
      onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className="panel">
      <h2>规范化规则（当前生效 v{state.activeRuleVersion}）</h2>
      <p className="muted small">
        规范化只能合并规则中<strong>明确声明为等价</strong>的部分；不会为了命中率自动排序全部参数。
        草案先对历史动作干跑，展示命中变化与“同键异输出”碰撞反例，批准后才形成新版本。
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>规则草案（下一版本 v{draft.version}）</h3>
        <div className="checkbox-row" style={{ marginBottom: 8 }}>
          <input
            id="sep"
            type="checkbox"
            checked={draft.normalizeSeparators}
            onChange={(e) => patch({ normalizeSeparators: e.target.checked })}
          />
          <label htmlFor="sep">声明路径分隔符 \ 与 / 等价</label>
        </div>
        <div className="checkbox-row" style={{ marginBottom: 8 }}>
          <input
            id="sym"
            type="checkbox"
            checked={draft.expandSymlinks}
            onChange={(e) => patch({ expandSymlinks: e.target.checked })}
          />
          <label htmlFor="sym">展开 symlink 到目标路径（未展开则 symlink 事实参与指纹）</label>
        </div>

        <label className="field">
          路径别名（每行 from=&gt;to，例如 ws=/workspace）
          <textarea
            style={{ minHeight: 60, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            value={draft.pathAliases.map((a) => `${a.from}=${a.to}`).join('\n')}
            onChange={(e) =>
              patch({
                pathAliases: e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [from, ...rest] = line.split('=');
                    return { from: from.trim(), to: rest.join('=').trim() };
                  }),
              })
            }
          />
        </label>
        <label className="field">
          可交换标志（逗号分隔；仅这些标志的值允许排序，如 -I）
          <input
            value={draft.commutativeFlags.join(', ')}
            onChange={(e) =>
              patch({
                commutativeFlags: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <label className="field">
          路径值标志（逗号分隔；这些标志的值做路径规范化，如 -I）
          <input
            value={draft.pathFlags.join(', ')}
            onChange={(e) =>
              patch({
                pathFlags: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>

        <div className="toolbar">
          <button className="btn" onClick={save}>保存草案</button>
          <button className="btn primary" onClick={runDry}>用历史动作干跑</button>
        </div>
      </div>

      {dry && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>干跑结果（共 {dry.totalActions} 个可派生动作）</h3>
          {dry.collisions.length > 0 && (
            <>
              <div className="tag-miss small" style={{ marginBottom: 6 }}>
                ⚠ 发现 {dry.collisions.length} 组碰撞反例：规范化后同 key 却有不同输出，不应批准
              </div>
              {dry.collisions.map((c) => (
                <div className="card collision" key={c.key}>
                  <div className="key-mono small">{c.key}</div>
                  <table className="tiny" style={{ marginTop: 6 }}>
                    <thead><tr><th>输出摘要</th><th>动作</th></tr></thead>
                    <tbody>
                      {c.outputGroups.map((g) => (
                        <tr key={g.outputHash}>
                          <td className="key-mono">{g.outputHash}</td>
                          <td>{g.actionIds.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
          {dry.newBenignHits.length > 0 && (
            <>
              <div className="tag-match small" style={{ marginBottom: 6 }}>
                新增 {dry.newBenignHits.length} 个良性命中（同输出，原先不同 key）
              </div>
              {dry.newBenignHits.map((h) => (
                <div className="small" key={h.key} style={{ marginBottom: 4 }}>
                  {h.actionIds.join(' ≡ ')} <span className="muted">→</span>{' '}
                  <span className="key-mono">{h.key.slice(0, 20)}…</span>
                </div>
              ))}
            </>
          )}
          <details style={{ marginTop: 8 }}>
            <summary className="muted small">{dry.changedKeys.length} 个动作 key 发生变化</summary>
            <table className="tiny" style={{ marginTop: 6 }}>
              <thead><tr><th>动作</th><th>旧 key</th><th>新 key</th></tr></thead>
              <tbody>
                {dry.changedKeys.map((c) => (
                  <tr key={c.actionId}>
                    <td>{c.actionId}</td>
                    <td className="key-mono">{c.oldKey.slice(0, 20)}…</td>
                    <td className="key-mono">{c.newKey.slice(0, 20)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <label className="field" style={{ marginTop: 10 }}>
            批准说明
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：启用分隔符等价与 -I 可交换" />
          </label>
          <button
            className="btn primary"
            disabled={dry.collisions.length > 0}
            title={dry.collisions.length > 0 ? '存在碰撞反例，禁止批准' : '批准为新版本'}
            onClick={approve}
          >
            批准为规则 v{dry.ruleVersion}
          </button>
          {dry.collisions.length > 0 && (
            <span className="muted small" style={{ marginLeft: 10 }}>
              请收窄等价声明，消除碰撞后再批准（如可执行位差异不能被别名掩盖）。
            </span>
          )}
        </div>
      )}

      <h3>规则版本历史（版本不可变；回滚即重新激活旧版本）</h3>
      <table className="tiny">
        <thead><tr><th>版本</th><th>说明</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
          {state.rules.map((r) => (
            <tr key={r.version}>
              <td>
                v{r.version}
                {r.version === state.activeRuleVersion && <span className="badge ok" style={{ marginLeft: 6 }}>生效中</span>}
              </td>
              <td>{r.note}</td>
              <td className="small">{r.createdAt}</td>
              <td>
                {r.version !== state.activeRuleVersion && (
                  <button className="btn small" onClick={() => rollback(r.version)}>回滚</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>规则事件</h3>
      <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
        {state.ruleEvents.map((e, i) => (
          <li key={i}>
            {e.at} · {e.kind === 'approve' ? '批准' : '回滚'} v
            {e.fromVersion ?? '?'} → v{e.toVersion}
            {e.detail ? ` · ${e.detail}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

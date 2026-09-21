import { useState } from 'react';
import { api, type State } from '../client';

export function DistrustPanel({
  state,
  refresh,
}: {
  state: State;
  refresh: () => Promise<unknown>;
}) {
  const [actionId, setActionId] = useState('gen_config');
  const [inputPath, setInputPath] = useState('tools/gen_config.py');
  const [correctDigest, setCorrectDigest] = useState('');
  const [busy, setBusy] = useState(false);

  const actionsWithInputs = state.actions.flatMap((a) => {
    const latest = a.observations[a.observations.length - 1];
    return latest
      ? latest.spec.inputs.map((f) => ({
          actionId: a.actionId,
          path: f.path,
          digest: f.digest,
        }))
      : [];
  });

  const submit = async () => {
    const picked = actionsWithInputs.find((x) => x.actionId === actionId && x.path === inputPath);
    if (!picked) return alert('找不到该输入');
    setBusy(true);
    try {
      await api.correction(actionId, inputPath, picked.digest, correctDigest || picked.digest + '00');
      await refresh();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>失信传播</h2>
      <p className="hint">
        某输入后来被发现摘要错误时，只使沿依赖图可达的动作失信；共享子图的所有下游受影响，无关分支保持可信。
      </p>

      <div className="form">
        <select value={actionId} onChange={(e) => setActionId(e.target.value)}>
          {state.actions.map((a) => (
            <option key={a.actionId} value={a.actionId}>
              {a.actionId}
            </option>
          ))}
        </select>
        <select value={inputPath} onChange={(e) => setInputPath(e.target.value)}>
          {actionsWithInputs
            .filter((x) => x.actionId === actionId)
            .map((x) => (
              <option key={x.path} value={x.path}>
                {x.path} ({x.digest.slice(0, 10)}…)
              </option>
            ))}
        </select>
        <input
          placeholder="纠正后的摘要（留空则演示追加 00）"
          value={correctDigest}
          onChange={(e) => setCorrectDigest(e.target.value)}
        />
        <button disabled={busy} onClick={submit}>
          登记摘要纠正
        </button>
      </div>

      <h3>纠正记录与传播范围</h3>
      {state.corrections.length === 0 && <p className="hint">尚无纠正记录。</p>}
      {state.corrections.map((c) => (
        <div key={c.id} className="correction">
          <div>
            <strong>{c.actionId}</strong> 的 <code>{c.inputPath}</code>：
            <code className="bad"> {c.badDigest.slice(0, 12)}…</code> →{' '}
            <code className="good">{c.correctDigest.slice(0, 12)}…</code>
          </div>
          <div className="propagate">
            失信传播到（{c.affectedActions.length}）：
            {c.affectedActions.map((id) => (
              <span key={id} className="chip warn">
                {id}
              </span>
            ))}
          </div>
        </div>
      ))}

      <h3>当前失信动作</h3>
      <ul>
        {state.actions
          .filter((a) => !a.trusted)
          .map((a) => (
            <li key={a.actionId}>
              <span className="warn">{a.actionId}</span>：{a.distrustReason}
            </li>
          ))}
        {state.actions.every((a) => a.trusted) && <li className="hint">全部可信。</li>}
      </ul>
    </section>
  );
}

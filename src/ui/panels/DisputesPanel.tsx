import type { State } from '../client';

export function DisputesPanel({ state }: { state: State }) {
  const open = state.disputes.filter((d) => d.status === 'open');
  const resolved = state.disputes.filter((d) => d.status === 'resolved');
  return (
    <section>
      <h2>争议条目</h2>
      <p className="hint">
        两个缓存条目共用 key 却有不同输出时进入争议：保留双方来源与首次观察顺序，永远不会被后写覆盖。
      </p>
      <h3>进行中（{open.length}）</h3>
      {open.length === 0 && <p className="hint">无开放争议。</p>}
      {open.map((d) => (
        <div key={d.id} className="dispute">
          <div className="dispute-head">
            <span className="badge danger">争议</span>
            <code>{d.key}</code>
            <span className="rule-tag">规则 v{d.ruleVersion}</span>
          </div>
          <table>
            <tbody>
              <tr>
                <td className="order">首次观察 #{d.firstResultVersion}</td>
                <td>{d.firstActionId}</td>
                <td>
                  <code>{d.firstOutputHash.slice(0, 20)}…</code>
                </td>
                <td>{new Date(d.firstObservedAt).toISOString()}</td>
                <td>{d.firstManifestId}</td>
              </tr>
              <tr>
                <td className="order">冲突来源 #{d.secondResultVersion}</td>
                <td>{d.secondActionId}</td>
                <td>
                  <code>{d.secondOutputHash.slice(0, 20)}…</code>
                </td>
                <td>{new Date(d.secondObservedAt).toISOString()}</td>
                <td>{d.secondManifestId}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      <h3>已收敛 / 已解决（{resolved.length}）</h3>
      {resolved.map((d) => (
        <div key={d.id} className="dispute resolved">
          <span className="badge ok">已收敛</span> <code>{d.key}</code>（历史保留：
          {d.firstActionId} ⇄ {d.secondActionId}）
        </div>
      ))}
    </section>
  );
}

import { useState } from 'react';
import { client, type ApiState } from './api';

export function DisputesPanel({
  state,
  reload,
  notify,
}: {
  state: ApiState;
  reload: () => void;
  notify: (msg: string, error?: boolean) => void;
}) {
  const [path, setPath] = useState('');
  const [digest, setDigest] = useState('');
  const [reason, setReason] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);

  const correct = async () => {
    try {
      setBusy(true);
      const r = await client.correct({
        path,
        newAlgo: 'sha256',
        newDigest: digest,
        reason,
      });
      notify(`已纠正 ${path}，${r.distrusted.length} 个可达动作失信`);
      setPath('');
      setDigest('');
      setReason('');
      reload();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (key: string) => {
    await client.resolveDispute(key, '人工复核：保留双方条目，不覆盖');
    reload();
  };

  const doImport = async () => {
    try {
      const batch = JSON.parse(importText);
      const r = await client.importBatch(batch);
      notify(
        `导入 ${r.batchId}：新增 ${r.inserted} 个动作` +
          (r.skipped.length ? `，跳过已存在 ${r.skipped.join(',')}` : '') +
          (r.missingDeps.length ? `；缺失依赖：${r.missingDeps.join(',')}` : ''),
      );
      setImportText('');
      reload();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className="panel">
      <h2>争议条目：同键异输出</h2>
      <p className="muted small">
        规则：同一 key 出现不同输出时进入争议，双方来源与首次观察顺序永久保留，
        后到的一方绝不覆盖先到条目。
      </p>
      {state.disputes.length === 0 && <div className="muted small">暂无争议</div>}
      {state.disputes.map((d) => (
        <div className="card dispute" key={d.id}>
          <div className="toolbar" style={{ marginBottom: 6 }}>
            <strong>争议 #{d.id}</strong>
            <span className={`badge ${d.status === 'open' ? 'failed' : 'ok'}`}>{d.status}</span>
            <span className="muted small">首次观察 {d.firstSeen}</span>
            {d.status === 'open' && (
              <button className="btn small" onClick={() => resolve(d.key)}>标记已处理</button>
            )}
          </div>
          <div className="key-mono small" style={{ marginBottom: 6 }}>{d.key}</div>
          <table className="tiny">
            <thead>
              <tr>
                <th>顺序</th>
                <th>动作</th>
                <th>输出摘要</th>
                <th>来源</th>
                <th>观察时间</th>
              </tr>
            </thead>
            <tbody>
              {d.parties.map((p) => (
                <tr key={p.ord}>
                  <td>#{p.ord + 1}</td>
                  <td>{p.actionId}</td>
                  <td className="key-mono">{p.outputHash}</td>
                  <td className="small muted">{p.source}</td>
                  <td className="small">{p.observedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.resolutionNote && <div className="small muted" style={{ marginTop: 6 }}>处理：{d.resolutionNote}</div>}
        </div>
      ))}

      <h2 style={{ marginTop: 28 }}>失信传播</h2>
      <p className="muted small">
        输入摘要被发现错误时，只标记从读取该输入的动作出发、沿依赖图反向可达的动作；
        无关节点不受影响。原始清单永不修改，纠正只作为派生输入。
      </p>

      <div className="card">
        <div className="grid-2">
          <div>
            <label className="field">输入路径
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="例如 src/core.c" />
            </label>
            <label className="field">新摘要（sha256 hex）
              <input value={digest} onChange={(e) => setDigest(e.target.value)} />
            </label>
            <label className="field">原因
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !path || !digest} onClick={correct}>
              提交纠正并重算传播
            </button>
          </div>
          <div>
            <div className="small muted">已失信动作（全部纠正的并集）：</div>
            <div className="small" style={{ marginTop: 6 }}>
              {state.distrusted.length
                ? state.distrusted.map((id) => <span key={id} className="badge distrust" style={{ marginRight: 6 }}>{id}</span>)
                : '（无）'}
            </div>
            {state.corrections.map((c) => (
              <div key={c.id} className="small" style={{ marginTop: 10 }}>
                <div><strong>{c.path}</strong> · {c.createdAt}</div>
                <div className="muted">{c.reason}</div>
                <div className="key-mono" style={{ color: 'var(--danger)' }}>{c.oldDigest}</div>
                <div className="key-mono" style={{ color: 'var(--ok)' }}>{c.newDigest}</div>
                <div className="muted">→ {state.distrustedByCorrection[c.path]?.join(', ')}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <h2 style={{ marginTop: 28 }}>导入动作清单（允许乱序）</h2>
      <p className="muted small">粘贴一个批次 JSON：{`{ "batchId", "receivedAt", "actions": [...] }`}。依赖缺失时动作进入 missing-deps，后续批次补齐后自动重算。</p>
      <textarea
        style={{ width: '100%', minHeight: 120, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        placeholder='{"batchId":"b-006","actions":[...]}'
      />
      <div style={{ marginTop: 8 }}>
        <button className="btn" onClick={doImport} disabled={!importText}>导入批次</button>
      </div>

      <h3>已导入批次</h3>
      <table className="tiny">
        <thead><tr><th>#</th><th>批次</th><th>接收时间</th><th>派生状态</th></tr></thead>
        <tbody>
          {state.batches.map((b) => (
            <tr key={b.batch_id}>
              <td>{b.ord}</td>
              <td>{b.batch_id}</td>
              <td>{b.received_at}</td>
              <td><span className={`badge ${b.status === 'derived' ? 'ok' : 'blocked'}`}>{b.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

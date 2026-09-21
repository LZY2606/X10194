import { useState } from 'react';
import { client, type ApiState } from './api';
import type { FingerprintComparison } from '../core/types';

export function ComparePanel({ state }: { state: ApiState }) {
  const [left, setLeft] = useState('compile_core');
  const [right, setRight] = useState('compile_winpath');
  const [result, setResult] = useState<FingerprintComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    try {
      setError(null);
      setResult(await client.compare(left, right));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const ids = state.actions.map((a) => a.id);

  return (
    <div className="panel">
      <h2>命中比较：两次动作为何命中 / 未命中</h2>
      <div className="toolbar">
        <label className="field" style={{ marginBottom: 0 }}>
          动作 A
          <select value={left} onChange={(e) => setLeft(e.target.value)}>
            {ids.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          动作 B
          <select value={right} onChange={(e) => setRight(e.target.value)}>
            {ids.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <button className="btn primary" onClick={run}>比较</button>
      </div>

      {error && <div className="toast error">{error}</div>}

      {result && (
        <div>
          <div className={`card ${result.hit ? '' : 'collision'}`}>
            <strong style={{ fontSize: 15 }}>
              {result.hit ? '✅ key 命中' : '❌ key 未命中'}
            </strong>
            <div className="small muted" style={{ marginTop: 6 }}>
              未命中组件：
              {result.mismatchedTags.length ? result.mismatchedTags.join(', ') : '（无）'}
            </div>
            <div className="key-mono small" style={{ marginTop: 6 }}>
              A: {result.leftKey}
            </div>
            <div className="key-mono small">B: {result.rightKey}</div>
          </div>

          {result.components.map((c) => (
            <details className="component" key={c.tag} open={!c.match}>
              <summary>
                <span className={`badge ${c.match ? 'tag-match' : 'tag-miss'}`}>
                  {c.match ? '一致' : '不同'}
                </span>
                <strong>{c.label}</strong>
                <span className="muted small" style={{ marginLeft: 'auto' }}>{c.tag}</span>
              </summary>
              <div className="body">
                <div className="rows">
                  <div>
                    <div className="muted small">A · {result.leftId}</div>
                    <pre>{c.left.join('\n') || '（空）'}</pre>
                  </div>
                  <div>
                    <div className="muted small">B · {result.rightId}</div>
                    <pre>{c.right.join('\n') || '（空）'}</pre>
                  </div>
                </div>
                {c.notes.length > 0 && (
                  <ul className="notes">
                    {c.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

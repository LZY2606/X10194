import { useMemo, useState } from 'react';
import type { ApiState } from './api';
import type { FingerprintComponent } from '../core/types';

function ComponentView({ comp, diff }: { comp: FingerprintComponent; diff?: boolean }) {
  return (
    <details className="component" open={comp.tag === 'inputs' || comp.tag === 'deps'}>
      <summary>
        <span className={`badge ${diff ? 'tag-miss' : 'tag-match'}`}>{comp.tag}</span>
        <strong>{comp.label}</strong>
        <span className="key-mono" style={{ marginLeft: 'auto' }}>
          {comp.digest.slice(0, 18)}…
        </span>
      </summary>
      <div className="body">
        <div className="rows">
          <div>
            <div className="muted small">规范化后（参与哈希，排序/展开后）</div>
            <pre>{comp.canonical.join('\n') || '（空）'}</pre>
          </div>
          <div>
            <div className="muted small">原始观察</div>
            <pre>{comp.observed.join('\n') || '（空）'}</pre>
          </div>
        </div>
        {comp.notes.length > 0 && (
          <ul className="notes">
            {comp.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function FingerprintPanel({
  state,
  selected,
  onSelect,
}: {
  state: ApiState;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const distrust = new Set(state.distrusted);
  const fps = useMemo(
    () =>
      state.fingerprints.filter(
        (f) => !q || f.actionId.includes(q) || f.key.includes(q),
      ),
    [state, q],
  );
  const fp = fps.find((f) => f.actionId === selected) ?? fps[0];
  const manifest = state.actions.find((a) => a.id === fp?.actionId)?.manifest;

  return (
    <div className="panel">
      <h2>指纹展开</h2>
      <div className="grid-2">
        <div>
          <input
            style={{ width: '100%', marginBottom: 8 }}
            placeholder="按动作 id 或 key 过滤…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="list">
            {fps.map((f) => (
              <li
                key={f.actionId}
                className={fp?.actionId === f.actionId ? 'selected' : ''}
                onClick={() => onSelect(f.actionId)}
              >
                <span>
                  {f.actionId}{' '}
                  <span className={`badge ${f.status}`}>{f.status}</span>
                  {distrust.has(f.actionId) && <span className="badge distrust">失信</span>}
                </span>
                <span className="meta">{f.key}</span>
              </li>
            ))}
          </ul>
        </div>

        {fp && (
          <div>
            <div className="toolbar">
              <span className="badge">rule v{fp.ruleVersion}</span>
              <span className={`badge ${fp.status}`}>{fp.status}</span>
              {distrust.has(fp.actionId) && <span className="badge distrust">摘要纠正失信</span>}
            </div>
            <div className="small muted">动作 key（组件摘要的有序哈希）：</div>
            <div className="key-mono" style={{ marginBottom: 10 }}>{fp.key}</div>
            <div className="small muted">结果版本（被依赖钉住，含输出）：</div>
            <div className="key-mono" style={{ marginBottom: 10 }}>{fp.resultVersion}</div>
            {manifest && (
              <div className="small muted" style={{ marginBottom: 10 }}>
                原始命令：{manifest.command.join(' ')}
                {manifest.failed && <span className="tag-miss"> · 该动作执行失败</span>}
              </div>
            )}
            {fp.correctedInputPaths && fp.correctedInputPaths.length > 0 && (
              <div className="small tag-miss" style={{ marginBottom: 10 }}>
                本次计算使用纠正后摘要：{fp.correctedInputPaths.join(', ')}
              </div>
            )}
            {fp.components.map((c) => (
              <ComponentView key={c.tag} comp={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

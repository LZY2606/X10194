import type { State } from '../client';

export function DagPanel({ state }: { state: State }) {
  const { nodes, edges } = state.dag;
  const radius = 210;
  const positioned = nodes.map((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return { ...n, x: 320 + radius * Math.cos(angle), y: 300 + radius * Math.sin(angle) };
  });
  const pos = new Map(positioned.map((n) => [n.id, n]));

  return (
    <section>
      <h2>动作 DAG</h2>
      <p className="hint">
        箭头由依赖方指向被依赖动作；失败节点标红，失信节点描虚线。共享子图（如 gen_config）可见多个入边。
      </p>
      <div className="dag-wrap">
        <svg width={640} height={600}>
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6" fill="#888" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#999"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            );
          })}
          {positioned.map((n) => (
            <g key={n.id}>
              <circle
                cx={n.x}
                cy={n.y}
                r={34}
                fill={n.status === 'failed' ? '#fde2e2' : n.trusted ? '#e3f2fd' : '#fff4e0'}
                stroke={n.status === 'failed' ? '#d33' : n.trusted ? '#1976d2' : '#e8941f'}
                strokeWidth={2}
                strokeDasharray={n.trusted ? undefined : '5 3'}
              />
              <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={11}>
                {n.id.length > 12 ? n.id.slice(0, 11) + '…' : n.id}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <table>
        <thead>
          <tr>
            <th>动作</th>
            <th>依赖</th>
            <th>最新结果</th>
            <th>信任</th>
          </tr>
        </thead>
        <tbody>
          {state.actions.map((a) => {
            const latest = a.observations[a.observations.length - 1];
            return (
              <tr key={a.actionId}>
                <td>{a.actionId}</td>
                <td>{a.deps.join(', ') || '—'}</td>
                <td>
                  #{a.latestResultVersion} {latest?.status}
                </td>
                <td>{a.trusted ? '可信' : <span className="warn">失信：{a.distrustReason}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

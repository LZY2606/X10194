import { useMemo, useState } from 'react';
import type { ApiState } from './api';

const STATUS_FILL: Record<string, string> = {
  ok: '#16324a',
  failed: '#4a1d24',
  blocked: '#4a3a16',
  'missing-deps': '#44321a',
};
const STATUS_STROKE: Record<string, string> = {
  ok: '#5eead4',
  failed: '#f87171',
  blocked: '#fbbf24',
  'missing-deps': '#fbbf24',
};

export function DagPanel({
  state,
  onSelect,
}: {
  state: ApiState;
  onSelect: (id: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    const fp = new Map(state.fingerprints.map((f) => [f.actionId, f]));
    const manifest = new Map(state.actions.map((a) => [a.id, a.manifest]));
    const declared = new Set(state.actions.map((a) => a.id));

    // 层级 = 最长依赖链长度；缺失依赖作为虚拟叶子
    const depthCache = new Map<string, number>();
    const depthOf = (id: string, trail: Set<string>): number => {
      if (depthCache.has(id)) return depthCache.get(id)!;
      const m = manifest.get(id);
      if (!m) return 0;
      if (trail.has(id)) return 0;
      const next = new Set(trail);
      next.add(id);
      const deps = m.deps.length ? Math.max(...m.deps.map((d) => depthOf(d, next) + 1)) : 0;
      depthCache.set(id, deps);
      return deps;
    };

    const ids = state.actions.map((a) => a.id);
    const levels = new Map<number, string[]>();
    for (const id of ids) {
      const lvl = depthOf(id, new Set());
      const list = levels.get(lvl) ?? [];
      list.push(id);
      levels.set(lvl, list);
    }

    const W = 190;
    const H = 58;
    const GAP_X = 40;
    const GAP_Y = 70;
    const positions = new Map<string, { x: number; y: number }>();
    const maxRows = Math.max(...[...levels.values()].map((l) => l.length));
    [...levels.entries()].forEach(([lvl, list]) => {
      list.sort();
      list.forEach((id, idx) => {
        positions.set(id, {
          x: lvl * (W + GAP_X) + 20,
          y: idx * (H + GAP_Y) + (maxRows - list.length) * 24 + 20,
        });
      });
    });

    const virtual = new Set<string>();
    for (const e of state.edges) if (!declared.has(e.to)) virtual.add(e.to);
    const virtualPositions = new Map<string, { x: number; y: number }>();
    let vIdx = 0;
    for (const id of [...virtual].sort()) {
      virtualPositions.set(id, { x: 20, y: (maxRows + vIdx) * (H + GAP_Y) + 20 });
      vIdx++;
    }

    return { positions, virtualPositions, fp, W, H, levelsSize: levels.size };
  }, [state]);

  const width = Math.max(900, layout.levelsSize * 230 + 40);
  const allY = [
    ...[...layout.positions.values()].map((p) => p.y),
    ...[...layout.virtualPositions.values()].map((p) => p.y),
  ];
  const height = (allY.length ? Math.max(...allY) : 0) + 120;
  const distrust = new Set(state.distrusted);

  return (
    <div className="panel">
      <h2>动作 DAG</h2>
      <p className="muted small">
        边方向：依赖 → 动作。颜色：<span className="tag-match">绿=正常</span>、
        <span className="tag-miss">红=失败</span>、黄=阻塞/缺失依赖；虚线连向尚未导入的动作；
        红色边框表示因输入摘要纠正而失信。
      </p>
      <div className="dag-wrap">
        <svg width={width} height={height}>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#7dd3fc" />
            </marker>
            <marker
              id="arrow-missing"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#fbbf24" />
            </marker>
          </defs>

          {state.edges.map((e) => {
            const from = layout.virtualPositions.get(e.to) ?? layout.positions.get(e.to);
            const to = layout.positions.get(e.from);
            if (!from || !to) return null;
            const x1 = from.x + layout.W;
            const y1 = from.y + layout.H / 2;
            const x2 = to.x;
            const y2 = to.y + layout.H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={e.declared ? '#7dd3fc' : '#fbbf24'}
                strokeOpacity={hover && hover !== e.from && hover !== e.to ? 0.25 : 0.8}
                strokeWidth={1.5}
                strokeDasharray={e.declared ? undefined : '5 4'}
                markerEnd={`url(#${e.declared ? 'arrow' : 'arrow-missing'})`}
              />
            );
          })}

          {state.actions.map((a) => {
            const p = layout.positions.get(a.id);
            const f = layout.fp.get(a.id);
            if (!p || !f) return null;
            const status = f.status;
            const isDistrust = distrust.has(a.id);
            return (
              <g
                key={a.id}
                className="dag-node"
                transform={`translate(${p.x},${p.y})`}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover(a.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelect(a.id)}
              >
                <rect
                  width={layout.W}
                  height={layout.H}
                  rx={8}
                  fill={STATUS_FILL[status]}
                  stroke={isDistrust ? '#f87171' : STATUS_STROKE[status]}
                  strokeDasharray={isDistrust ? '4 3' : undefined}
                />
                <text x={10} y={20}>{a.id}</text>
                <text className="sub" x={10} y={37}>
                  {status}
                  {isDistrust ? ' · 失信' : ''}
                </text>
                <text className="sub" x={10} y={50}>{f.key.slice(0, 14)}…</text>
              </g>
            );
          })}

          {[...layout.virtualPositions.entries()].map(([id, p]) => (
            <g key={id} className="dag-node" transform={`translate(${p.x},${p.y})`}>
              <rect width={layout.W} height={layout.H} rx={8} fill="#2a2118" stroke="#fbbf24" strokeDasharray="5 4" />
              <text x={10} y={22}>{id}</text>
              <text className="sub" x={10} y={40}>尚未导入（乱序）</text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

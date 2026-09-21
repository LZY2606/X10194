import { useMemo } from "react";
import type { ActionNode } from "../shared/types";

interface Props {
  actions: ActionNode[];
  selected?: string;
  onSelect: (action: ActionNode) => void;
}

const COLORS: Record<string, string> = {
  ok: "#34d399",
  failed: "#f87171",
  blocked: "#fbbf24",
  distrusted: "#fb923c",
  invalid: "#c084fc",
};

export function DagView({ actions, selected, onSelect }: Props) {
  const layout = useMemo(() => {
    // 按导入分组，每个导入内做最长路径分层
    const groups = new Map<number, ActionNode[]>();
    for (const action of actions) {
      if (!groups.has(action.importId)) groups.set(action.importId, []);
      groups.get(action.importId)!.push(action);
    }
    const positioned: { action: ActionNode; x: number; y: number; group: number }[] = [];
    const edges: { x1: number; y1: number; x2: number; y2: number; dashed: boolean; key: string }[] =
      [];
    const NODE_W = 170;
    const NODE_H = 56;
    const GAP_X = 36;
    const GAP_Y = 28;
    let offsetX = 0;

    let groupIndex = 0;
    for (const [, groupActions] of groups) {
      const byId = new Map(groupActions.map((a) => [`${a.importId}:${a.id}`, a]));
      const depth = new Map<string, number>();
      const depthOf = (uid: string, guard = new Set<string>()): number => {
        if (depth.has(uid)) return depth.get(uid)!;
        if (guard.has(uid)) return 0;
        guard.add(uid);
        const action = byId.get(uid);
        if (!action || action.deps.length === 0) {
          depth.set(uid, 0);
          return 0;
        }
        const d =
          Math.max(
            ...action.deps.map((dep) => {
              const depUid = `${action.importId}:${dep}`;
              return byId.has(depUid) ? depthOf(depUid, new Set(guard)) + 1 : 0;
            }),
          );
        depth.set(uid, d);
        return d;
      };
      for (const action of groupActions) depthOf(`${action.importId}:${action.id}`);

      const layers = new Map<number, ActionNode[]>();
      for (const action of groupActions) {
        const d = depth.get(`${action.importId}:${action.id}`) ?? 0;
        if (!layers.has(d)) layers.set(d, []);
        layers.get(d)!.push(action);
      }
      const positions = new Map<string, { x: number; y: number }>();
      let maxWidth = 0;
      for (const [d, layer] of [...layers].sort(([x], [y]) => x - y)) {
        layer.sort((a, b) => (a.id < b.id ? -1 : 1));
        layer.forEach((action, i) => {
          const x = offsetX + d * (NODE_W + GAP_X);
          const y = i * (NODE_H + GAP_Y);
          positions.set(`${action.importId}:${action.id}`, { x, y });
          positioned.push({ action, x, y, group: groupIndex });
        });
        maxWidth = Math.max(maxWidth, (d + 1) * (NODE_W + GAP_X));
      }
      for (const action of groupActions) {
        const from = positions.get(`${action.importId}:${action.id}`)!;
        for (const dep of action.deps) {
          const to = positions.get(`${action.importId}:${dep}`);
          if (!to) continue;
          edges.push({
            x1: from.x,
            y1: from.y + NODE_H / 2,
            x2: to.x + NODE_W,
            y2: to.y + NODE_H / 2,
            dashed: action.health === "distrusted",
            key: `${action.importId}:${action.id}->${dep}`,
          });
        }
      }
      offsetX += maxWidth + 80;
      groupIndex += 1;
    }
    const height =
      Math.max(0, ...positioned.map((p) => p.y)) + NODE_H + 20;
    return { positioned, edges, width: offsetX, height, NODE_W, NODE_H };
  }, [actions]);

  return (
    <div className="dag-wrap">
      <svg width={Math.max(layout.width, 600)} height={layout.height}>
        {layout.edges.map((edge) => (
          <line
            key={edge.key}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            stroke="#3b4a76"
            strokeWidth={1.5}
            strokeDasharray={edge.dashed ? "5 4" : undefined}
            markerEnd="url(#arrow)"
          />
        ))}
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
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b4a76" />
          </marker>
        </defs>
        {layout.positioned.map(({ action, x, y }) => {
          const color = COLORS[action.health] ?? "#8b97b8";
          const isSel = selected === `${action.importId}:${action.id}`;
          return (
            <g
              key={`${action.importId}:${action.id}`}
              transform={`translate(${x},${y})`}
              style={{ cursor: "pointer" }}
              onClick={() => onSelect(action)}
            >
              <rect
                width={layout.NODE_W}
                height={layout.NODE_H}
                rx={8}
                fill="#17203a"
                stroke={isSel ? "#5eead4" : color}
                strokeWidth={isSel ? 2.5 : 1.5}
              />
              <rect width={6} height={layout.NODE_H} rx={3} fill={color} />
              <text x={14} y={20} fill="#e6ecff" fontSize={12} fontFamily="SF Mono, Menlo">
                {action.id.length > 20 ? action.id.slice(0, 19) + "…" : action.id}
              </text>
              <text x={14} y={38} fill="#8b97b8" fontSize={10} fontFamily="SF Mono, Menlo">
                {action.command} · #{action.importId}
              </text>
              <text x={layout.NODE_W - 10} y={38} textAnchor="end" fill={color} fontSize={10}>
                {action.health}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><span className="swatch" style={{ background: COLORS.ok }} />成功</span>
        <span><span className="swatch" style={{ background: COLORS.failed }} />失败节点</span>
        <span><span className="swatch" style={{ background: COLORS.blocked }} />被失败依赖阻塞</span>
        <span><span className="swatch" style={{ background: COLORS.distrusted }} />摘要纠正后失信</span>
        <span><span className="swatch" style={{ background: COLORS.invalid }} />图无效（循环/缺依赖）</span>
        <span>虚线边：失信传播路径</span>
      </div>
    </div>
  );
}

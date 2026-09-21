import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type FullState } from "./api.ts";
import type { ActionNode } from "../shared/types.ts";
import { DagView } from "./DagView.tsx";
import { Fingerprint } from "./Fingerprint.tsx";
import { CompareView } from "./CompareView.tsx";
import { DisputesView } from "./DisputesView.tsx";
import { RulesView } from "./RulesView.tsx";
import { TrustView } from "./TrustView.tsx";

type Tab = "dag" | "compare" | "disputes" | "rules" | "trust";

const TABS: { id: Tab; label: string }[] = [
  { id: "dag", label: "动作 DAG / 指纹展开" },
  { id: "compare", label: "命中比较" },
  { id: "disputes", label: "争议条目" },
  { id: "rules", label: "规则草案与版本" },
  { id: "trust", label: "失信传播 / 导入恢复" },
];

export function App() {
  const [state, setState] = useState<FullState | null>(null);
  const [tab, setTab] = useState<Tab>("dag");
  const [selected, setSelected] = useState<ActionNode | null>(null);
  const [toast, setToast] = useState("");

  const refresh = useCallback(async () => {
    const next = await api.state();
    setState(next);
    if (selected) {
      const still = next.actions.find(
        (a) => a.importId === selected.importId && a.id === selected.id,
      );
      setSelected(still ?? null);
    }
  }, [selected]);

  useEffect(() => {
    refresh().catch((e) => setToast("加载失败：" + e.message));
  }, []);

  const currentRuleId = useMemo(() => {
    if (!state) return 1;
    return Math.max(...state.rules.filter((r) => r.status === "approved").map((r) => r.id));
  }, [state]);

  const selectAction = (action: ActionNode) => {
    setSelected(action);
  };

  if (!state) return <main>正在打开构建指纹舱…</main>;

  const counts = {
    ok: state.actions.filter((a) => a.health === "ok").length,
    failed: state.actions.filter((a) => a.health === "failed" || a.health === "blocked").length,
    distrusted: state.actions.filter((a) => a.health === "distrusted").length,
    disputes: state.disputes.length,
  };

  return (
    <div>
      <header>
        <h1>构建指纹舱</h1>
        <span className="sub">
          离线复盘每个构建 key 的来历 · 原始清单不可变 · 当前规则 v{currentRuleId}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn"
          onClick={async () => {
            await api.resetDemo();
            await refresh();
            setToast("演示数据已重置");
          }}
        >
          重置演示数据
        </button>
      </header>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <main>
        <div className="row" style={{ marginBottom: 12, fontSize: 12 }}>
          <span className="badge ok">正常 {counts.ok}</span>
          <span className="badge failed">失败/阻塞 {counts.failed}</span>
          <span className="badge distrusted">失信 {counts.distrusted}</span>
          <span className="badge disputed">争议 {counts.disputes}</span>
          <span className="muted">
            {state.entries.length} 条缓存观察 · {state.actions.length} 个动作 · {state.imports.length} 次导入
          </span>
        </div>

        {tab === "dag" && (
          <div>
            <div className="panel">
              <h2>动作 DAG（点击节点展开指纹）</h2>
              <DagView
                actions={state.actions}
                selected={selected ? `${selected.importId}:${selected.id}` : undefined}
                onSelect={selectAction}
              />
            </div>
            {selected && (
              <div className="panel">
                <h2>
                  指纹展开：<span className="mono">{selected.importId}:{selected.id}</span>{" "}
                  <span className={`badge ${selected.health}`}>{selected.health}</span>
                </h2>
                <Fingerprint action={selected} key={`${selected.importId}:${selected.id}:${selected.key}`} />
              </div>
            )}
          </div>
        )}

        {tab === "compare" && <CompareView actions={state.actions} onRefresh={refresh} />}
        {tab === "disputes" && (
          <DisputesView entries={state.entries} disputes={state.disputes} onChanged={refresh} />
        )}
        {tab === "rules" && (
          <RulesView rules={state.rules} currentRuleId={currentRuleId} onChanged={refresh} />
        )}
        {tab === "trust" && (
          <TrustView
            actions={state.actions}
            imports={state.imports}
            corrections={state.corrections}
            distrust={state.distrust}
            recovery={state.recovery}
            onChanged={refresh}
          />
        )}
      </main>
      {toast && (
        <div className="toast" onClick={() => setToast("")}>{toast}</div>
      )}
    </div>
  );
}

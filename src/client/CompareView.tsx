import { useState } from "react";
import { api } from "./api.ts";
import type { ActionNode, CompareResult } from "../shared/types.ts";

export function CompareView({ actions, onRefresh }: { actions: ActionNode[]; onRefresh: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [err, setErr] = useState("");

  const run = async () => {
    setErr("");
    const [ai, aa] = a.split("::");
    const [bi, bb] = b.split("::");
    if (!ai || !bi) {
      setErr("请选择两个动作");
      return;
    }
    try {
      setResult(
        await api.compare(
          { importId: Number(ai), actionId: aa },
          { importId: Number(bi), actionId: bb },
        ),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const options = actions.map((act) => ({
    value: `${act.importId}::${act.id}`,
    label: `#${act.importId} ${act.id} (${act.health})`,
  }));

  return (
    <div className="panel">
      <h2>命中比较：两次动作为何命中 / 未命中</h2>
      <div className="row">
        <select value={a} onChange={(e) => setA(e.target.value)}>
          <option value="">选择动作 A</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">选择动作 B</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button className="btn primary" onClick={run}>比较</button>
        <button className="btn" onClick={onRefresh}>刷新数据</button>
      </div>
      {err && <div className="danger-box">{err}</div>}
      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="row">
            <span className={`badge ${result.verdict}`} style={{ fontSize: 14, padding: "4px 14px" }}>
              {result.verdict === "true-hit"
                ? "真命中：同 key 同结果版本"
                : result.verdict === "disputed-hit"
                  ? "争议命中：同 key 但结果版本不同"
                  : "未命中：key 不同"}
            </span>
            {result.firstDifferingComponent && (
              <span className="muted">首个分叉组件：<b>{result.firstDifferingComponent}</b></span>
            )}
          </div>
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr><th>组件</th><th>是否一致</th><th>A 规范化值</th><th>B 规范化值</th></tr>
            </thead>
            <tbody>
              {result.componentDiffs.map((diff) => (
                <tr key={diff.component}>
                  <td className="mono">{diff.component}</td>
                  <td className={diff.equal ? "diff-equal" : "diff-diff"}>
                    {diff.equal ? "一致" : "不同"}
                  </td>
                  <td><pre>{JSON.stringify(diff.a.normalized)}</pre></td>
                  <td><pre>{JSON.stringify(diff.b.normalized)}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid2" style={{ marginTop: 8 }}>
            <div>
              <div className="muted">A key</div>
              <div className="mono hash">{result.keyA}</div>
              <div className="muted">A 结果版本</div>
              <div className="mono hash">{result.resultHashA}</div>
            </div>
            <div>
              <div className="muted">B key</div>
              <div className="mono hash">{result.keyB}</div>
              <div className="muted">B 结果版本</div>
              <div className="mono hash">{result.resultHashB}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

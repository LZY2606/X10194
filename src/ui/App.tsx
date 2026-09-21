import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Snapshot } from "./api.js";
import { Badge, JsonBlock, short } from "./format.js";
import "./styles.css";

type CompareResult = any;

function stateTone(state: string) {
  return { hit: "good", disputed: "warn", distrusted: "bad", miss: "neutral" }[state] ?? "neutral";
}

function Dag({ state }: { state: Snapshot }) {
  const nodes = state.graph;
  const levels = new Map<string, number>();
  const byId = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
  const levelOf = (id: string): number => {
    if (levels.has(id)) return levels.get(id)!;
    const node = byId.get(id);
    const level = node.dependencies.length ? Math.max(...node.dependencies.map(levelOf)) + 1 : 0;
    levels.set(id, level);
    return level;
  };
  nodes.forEach((node: any) => levelOf(node.id));
  const columns = new Map<number, any[]>();
  nodes.forEach((node: any) => {
    const level = levels.get(node.id)!;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  });
  return (
    <section className="card dag">
      <h2>动作 DAG</h2>
      <div className="dag-columns">
        {[...columns.entries()].sort(([a], [b]) => a - b).map(([level, column]: [number, any[]]) => (
          <div className="dag-column" key={level}>
            <div className="column-title">L{level}</div>
            {column.map((node) => {
              const action = state.actions.find((item: any) => item.action.id === node.id);
              return (
                <div className={`dag-node ${action.cacheState}`} key={`${node.manifestId}:${node.id}`}>
                  <strong>{node.id}</strong>
                  <small>{node.manifestId}</small>
                  <div><Badge tone={node.status === "failed" ? "bad" : "good"}>{node.status}</Badge></div>
                  <div><Badge tone={stateTone(action.cacheState)}>{action.cacheState}</Badge></div>
                  {node.dependencies.length > 0 && <small>→ {node.dependencies.join(", ")}</small>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function Fingerprints({ state, selected, setSelected }: { state: Snapshot; selected: string | null; setSelected: (id: string | null) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>指纹展开</h2>
      <p className="hint">输出摘要不进入 action key；依赖钉住 result version；输入按稳定 ID 排序但参数不会被随意重排。</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>动作</th><th>规则</th><th>Action Key</th><th>Result Version</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {state.actions.map((entry: any) => {
              const id = `${entry.manifestId}:${entry.action.id}`;
              return (
                <React.Fragment key={`${id}:${entry.generation}`}>
                  <tr>
                    <td>{entry.action.id}</td>
                    <td>v{entry.fingerprint.ruleVersion}/g{entry.generation}</td>
                    <td><code title={entry.fingerprint.key}>{short(entry.fingerprint.key, 18)}</code></td>
                    <td><code title={entry.fingerprint.resultVersion}>{short(entry.fingerprint.resultVersion, 18)}</code></td>
                    <td><Badge tone={stateTone(entry.cacheState)}>{entry.cacheState}</Badge></td>
                    <td>
                      <button onClick={() => setExpanded(expanded === id ? null : id)}>组成</button>
                      <button onClick={() => setSelected(id)}>比较</button>
                    </td>
                  </tr>
                  {expanded === id && (
                    <tr className="expansion"><td colSpan={6}><Components entry={entry} /></td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Components({ entry }: { entry: any }) {
  return (
    <div className="components">
      {!entry.trusted && <div className="alert">失信：{entry.distrustReasons.join("；")}</div>}
      {entry.fingerprint.components.map((component: any) => (
        <details key={component.component}>
          <summary>
            <strong>{component.component}</strong> <code>{short(component.digest, 18)}</code>
            {component.rulesApplied.length > 0 && <Badge tone="good">{component.rulesApplied.join(", ")}</Badge>}
          </summary>
          {component.notes.map((note: string) => <p className="hint" key={note}>{note}</p>)}
          <div className="side-by-side">
            <div><h4>原始/事实</h4><JsonBlock value={component.before} /></div>
            <div><h4>规范化/钉住</h4><JsonBlock value={component.canonical} /></div>
          </div>
        </details>
      ))}
    </div>
  );
}

function Compare({ state, selection, onResult, choose }: {
  state: Snapshot;
  selection: { left: string | null; right: string | null };
  onResult: (result: CompareResult | null) => void;
  choose: (id: string) => void;
}) {
  const options = state.actions;
  const run = async () => {
    if (!selection.left || !selection.right) return;
    const [leftManifest, leftAction] = selection.left.split(":");
    const [rightManifest, rightAction] = selection.right.split(":");
      onResult(await api.compare({ manifestId: leftManifest!, actionId: leftAction! }, { manifestId: rightManifest!, actionId: rightAction! }));
  };
  const Select = ({ side }: { side: "left" | "right" }) => (
    <select value={selection[side] ?? ""} onChange={(event) => {
      const next = { ...selection };
      next[side] = event.target.value || null;
      onResult(null);
      choose(next[side] ?? "");
    }}>
      <option value="">选择动作</option>
      {options.map((entry: any) => <option key={`${entry.manifestId}:${entry.action.id}`} value={`${entry.manifestId}:${entry.action.id}`}>{entry.action.id}</option>)}
    </select>
  );
  return (
    <section className="card">
      <h2>命中比较</h2>
      <div className="controls"><Select side="left" /><span>vs</span><Select side="right" /><button onClick={run}>比较</button></div>
    </section>
  );
}

function CompareResultPanel({ result }: { result: CompareResult | null }) {
  if (!result) return null;
  return (
    <section className="card">
      <h2>比较解释 {result.keyMatch ? <Badge tone="good">同 key</Badge> : <Badge tone="warn">不同 key</Badge>}</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>组成</th><th>结果</th><th>左侧</th><th>右侧</th></tr></thead>
        <tbody>
          {result.components.map((row: any) => (
            <tr key={row.component}>
              <td>{row.component}</td>
              <td><Badge tone={row.match ? "good" : "warn"}>{row.match ? "一致" : "差异"}</Badge></td>
              <td><JsonBlock value={{ canonical: row.left.canonical, digest: row.left.digest, notes: row.left.notes }} /></td>
              <td><JsonBlock value={{ canonical: row.right.canonical, digest: row.right.digest, notes: row.right.notes }} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

function Disputes({ state }: { state: Snapshot }) {
  return (
    <section className="card">
      <h2>争议条目</h2>
      <p className="hint">同 key 异输出不会最后写入覆盖；保留双方来源、输出和首次观察顺序。</p>
      {state.disputes.length === 0 && <div className="empty">暂无争议</div>}
      {state.disputes.map((dispute: any) => (
        <details className="dispute" key={dispute.id}>
          <summary><Badge tone="warn">#{dispute.id}</Badge> <code>{short(dispute.actionKey, 22)}</code></summary>
          <div className="side-by-side">
            <div><h4>首次观察 #{dispute.firstEntryId}</h4><p>{dispute.firstSource}</p><p>{dispute.firstObservedAt}</p><code>{short(dispute.firstOutputDigest, 24)}</code></div>
            <div><h4>冲突观察 #{dispute.conflictingEntryId}</h4><p>{dispute.conflictingSource}</p><p>{dispute.conflictingObservedAt}</p><code>{short(dispute.conflictingOutputDigest, 24)}</code></div>
          </div>
        </details>
      ))}
      <h3>缓存观察流水</h3>
      <div className="entries">
        {state.cache.map((entry: any) => <div className="cache-entry" key={entry.id}><b>#{entry.observationOrder}</b> <code>{short(entry.actionKey, 14)}</code> <Badge tone={stateTone(entry.state)}>{entry.state}</Badge><span>{entry.source}</span></div>)}
      </div>
    </section>
  );
}

function Propagation({ state, refresh }: { state: Snapshot; refresh: () => Promise<void> }) {
  const [form, setForm] = useState({ manifestId: state.manifests[0]?.id ?? "", inputId: "", oldDigest: "", newDigest: "" });
  const [message, setMessage] = useState("");
  const submit = async () => {
    try {
      const result = await api.correct(form);
      setMessage(`第 ${result.generation} 代纠正；失信传播到：${result.reachable.join(", ")}`);
      await refresh();
    } catch (error) { setMessage((error as Error).message); }
  };
  return (
    <section className="card">
      <h2>失信传播</h2>
      <p className="hint">纠正某个输入摘要后，只令直接/反向可达动作失信；不可达共享子图不受影响。</p>
      <div className="form-grid">
        <input placeholder="manifest id" value={form.manifestId} onChange={(e) => setForm({ ...form, manifestId: e.target.value })} />
        <input placeholder="input id（如 core.h）" onChange={(e) => setForm({ ...form, inputId: e.target.value })} />
        <input placeholder="当前旧摘要" onChange={(e) => setForm({ ...form, oldDigest: e.target.value })} />
        <input placeholder="新摘要" onChange={(e) => setForm({ ...form, newDigest: e.target.value })} />
        <button onClick={submit}>纠正并传播</button>
      </div>
      {message && <div className="alert">{message}</div>}
      <div className="entries">{state.corrections.map((correction: any) => <div key={correction.id}>g{correction.id} {correction.inputId}: {short(correction.oldDigest)} → {short(correction.newDigest)}</div>)}</div>
    </section>
  );
}

function Rules({ state, refresh }: { state: Snapshot; refresh: () => Promise<void> }) {
  const [draftJson, setDraftJson] = useState("[]");
  const [dry, setDry] = useState<any>(null);
  const [message, setMessage] = useState("");
  const createTemplate = async () => {
    const draft = await api.templateDraft();
    setDraftJson(JSON.stringify(draft.rules, null, 2));
    setMessage(`草案 v${draft.version} 已创建`);
    await refresh();
  };
  const createCustom = async () => {
    const draft = await fetch("/api/rules/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: JSON.parse(draftJson), description: "界面规则草案" }),
    }).then((r) => r.json());
    if (draft.error) throw new Error(draft.error);
    setMessage(`草案 v${draft.version} 已创建`);
    await refresh();
  };
  return (
    <section className="card rules">
      <h2>规范化规则版本</h2>
      <div className="controls">
        <button onClick={createTemplate}>建立演示草案</button>
        <button onClick={() => { createCustom().catch((e) => setMessage(e.message)); }}>保存 JSON 草案</button>
      </div>
      <textarea value={draftJson} onChange={(event) => setDraftJson(event.target.value)} spellCheck={false} />
      {message && <div className="alert">{message}</div>}
      <div className="rule-list">
        {state.rules.map((ruleSet: any) => (
          <div className="rule-row" key={ruleSet.version}>
            <div><b>v{ruleSet.version}</b> <Badge tone={ruleSet.status === "approved" ? "good" : ruleSet.status === "draft" ? "warn" : "bad"}>{ruleSet.status}</Badge></div>
            <small>{ruleSet.description}</small>
            <div className="rule-actions">
              {ruleSet.status === "draft" && <>
                <button onClick={async () => setDry(await api.dryRun(ruleSet.version))}>干跑</button>
                <button onClick={async () => { await api.approve(ruleSet.version); setMessage(`v${ruleSet.version} 已批准`); await refresh(); }}>批准</button>
              </>}
              {ruleSet.status === "approved" && state.activeRules.version !== ruleSet.version &&
                <button onClick={async () => { await api.rollback(ruleSet.version); setMessage(`已生成回滚新版本`); await refresh(); }}>回滚到此版本</button>}
            </div>
            <details><summary>{ruleSet.rules.length} 条规则</summary><JsonBlock value={ruleSet.rules} /></details>
          </div>
        ))}
      </div>
      {dry && <DryRun dry={dry} />}
    </section>
  );
}

function DryRun({ dry }: { dry: any }) {
  return (
    <div className="dryrun">
      <h3>历史干跑：v{dry.baseline.version} → v{dry.draft.version}</h3>
      <div className="metric-grid">
        <div><b>{dry.changedKeys.length}</b><span>变化 key</span></div>
        <div><b>{dry.newCompatiblePairs.length}</b><span>命中等价组</span></div>
        <div><b>{dry.oldCollisions.length}</b><span>旧碰撞</span></div>
        <div className={dry.newCollisions.length ? "bad-number" : ""}><b>{dry.newCollisions.length}</b><span>新碰撞反例</span></div>
      </div>
      {dry.collisionExamples.map((group: any[], index: number) => (
        <details className="dispute" key={index}>
          <summary>碰撞反例 #{index + 1}</summary>
          <JsonBlock value={group} />
        </details>
      ))}
      <details><summary>变化明细</summary><JsonBlock value={dry.changedKeys} /></details>
    </div>
  );
}

function ImportPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  return (
    <section className="card import">
      <h2>导入原始动作清单</h2>
      <p className="hint">原始 manifest 入库后不可变；依赖可乱序出现，但缺失、重复和成环会被拒绝。</p>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴 ManifestImport JSON" spellCheck={false} />
      <button onClick={async () => {
        try {
          await api.importManifest(JSON.parse(text));
          setMessage("导入成功，已按当前批准规则生成派生 key");
          setText("");
          await refresh();
        } catch (error) { setMessage((error as Error).message); }
      }}>导入</button>
      {message && <div className="alert">{message}</div>}
    </section>
  );
}

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<{ left: string | null; right: string | null }>({ left: null, right: null });
  const [comparison, setComparison] = useState<CompareResult | null>(null);
  const refresh = useMemo(() => async () => setState(await api.state()), []);
  useEffect(() => { refresh().catch((error) => setError(error.message)); }, [refresh]);

  const seed = async () => {
    await api.seed();
    await refresh();
  };

  if (!state) return <main className="loading">正在打开构建指纹舱…{error && <div className="alert">{error}</div>}</main>;
  const choose = (id: string | null) => {
    if (!id) return;
    if (!selection.left) setSelection({ ...selection, left: id });
    else if (!selection.right) setSelection({ ...selection, right: id });
    else setSelection({ left: id, right: null });
  };
  return (
    <main>
      <header>
        <div>
          <h1>构建指纹舱</h1>
          <p>离线复盘构建缓存 key、命中原因、争议来源和失信传播。当前规则 v{state.activeRules.version}。</p>
        </div>
        <button className="primary" onClick={seed}>载入离线演示</button>
      </header>
      {state.manifests.length === 0 && <section className="card hero"><h2>空舱就绪</h2><p>点击“载入离线演示”生成 SQLite 数据，或粘贴导入动作清单。</p></section>}
      <div className="layout">
        <Dag state={state} />
        <section className="card">
          <h2>比较选择</h2>
          <p className="hint">在指纹表点击“比较”选择左右动作。</p>
          <div className="controls"><span>左：{selection.left ?? "未选"}</span><span>右：{selection.right ?? "未选"}</span><button onClick={() => { setSelection({ left: null, right: null }); setComparison(null); }}>清空</button></div>
        </section>
        <Compare state={state} selection={selection} onResult={setComparison} choose={choose} />
        <CompareResultPanel result={comparison} />
        <Fingerprints state={state} selected={null} setSelected={choose} />
        <Disputes state={state} />
        <Propagation state={state} refresh={refresh} />
        <Rules state={state} refresh={refresh} />
        <ImportPanel refresh={refresh} />
      </div>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);

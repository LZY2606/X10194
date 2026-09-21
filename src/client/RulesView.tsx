import { useMemo, useState } from "react";
import { api } from "./api.ts";
import { DEFAULT_RULE } from "../shared/rules";
import type { DryRunResult, RuleSpec, RuleVersion } from "../shared/types";

interface Props {
  rules: RuleVersion[];
  currentRuleId: number;
  onChanged: () => void;
}

export function RulesView({ rules, currentRuleId, onChanged }: Props) {
  const current = rules.find((r) => r.id === currentRuleId) ?? rules[rules.length - 1];
  const [spec, setSpec] = useState<RuleSpec>(() => JSON.parse(JSON.stringify(current.spec)));
  const [note, setNote] = useState("草案：路径别名 + 声明 -D 可交换");
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const specText = useMemo(() => JSON.stringify(spec, null, 2), [spec]);

  const applyText = (text: string) => {
    try {
      const parsed = JSON.parse(text) as RuleSpec;
      setSpec({ ...DEFAULT_RULE, ...parsed });
      setErr("");
    } catch (e) {
      setErr("JSON 解析失败：" + (e as Error).message);
    }
  };

  const doDryRun = async () => {
    setErr("");
    setMsg("");
    try {
      setDry(await api.dryRun(spec));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveDraft = async () => {
    setErr("");
    setMsg("");
    try {
      const draft = await api.createDraft(spec, note || "规则草案");
      setMsg(`草案 v${draft.id} 已建立，尚未影响任何命中。`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const approve = async (id: number) => {
    try {
      await api.approve(id);
      setMsg(`草案 v${id} 已批准为新规则版本并完成历史重放。`);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const rollback = async (id: number) => {
    try {
      const v = await api.rollback(id);
      setMsg(`已生成 v${v.id} 恢复 v${id} 的规则（旧版本保持不可变）。`);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggle = (key: keyof RuleSpec) =>
    setSpec((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div>
      <div className="panel">
        <h2>规范化规则版本</h2>
        <table>
          <thead>
            <tr><th>版本</th><th>状态</th><th>说明</th><th>恢复自</th><th>操作</th></tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="mono">v{rule.id}{rule.id === currentRuleId ? " ★生效" : ""}</td>
                <td><span className={`badge ${rule.status}`}>{rule.status}</span></td>
                <td>{rule.note}</td>
                <td>{rule.restoresVersionId ? `v${rule.restoresVersionId}` : "—"}</td>
                <td className="row">
                  <button className="btn" onClick={() => setSpec(JSON.parse(JSON.stringify(rule.spec)))}>
                    载入
                  </button>
                  {rule.status === "draft" && (
                    <button className="btn primary" onClick={() => approve(rule.id)}>批准</button>
                  )}
                  {rule.status === "approved" && rule.id !== currentRuleId && (
                    <button className="btn danger" onClick={() => rollback(rule.id)}>回滚到此版</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>规则草案编辑器（只显式声明等价）</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="row">
            <input
              type="checkbox"
              checked={spec.normalizePathSeparators}
              onChange={() => toggle("normalizePathSeparators")}
            />
            归一路径分隔符（\ → /）
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={spec.ignoreMode}
              onChange={() => toggle("ignoreMode")}
            />
            忽略可执行位/权限位
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={spec.ignorePlatform}
              onChange={() => toggle("ignorePlatform")}
            />
            忽略平台属性
          </label>
          <label className="row">
            symlink 取证：
            <select
              value={spec.symlinkPolicy}
              onChange={(e) => setSpec((s) => ({ ...s, symlinkPolicy: e.target.value as RuleSpec["symlinkPolicy"] }))}
            >
              <option value="link">按链接字符串</option>
              <option value="target-digest">按目标内容摘要</option>
            </select>
          </label>
        </div>
        <div className="grid2">
          <div>
            <div className="muted">路径别名（物理前缀 → 规范 token）</div>
            <textarea
              value={JSON.stringify(spec.pathAliases, null, 2)}
              onChange={(e) => {
                const value = safeParse(e.target.value, spec.pathAliases);
                setSpec((cur) => ({ ...cur, pathAliases: value as RuleSpec["pathAliases"] }));
              }}
            />
          </div>
          <div>
            <div className="muted">可交换参数标志（如 ["-D"]；其余参数保序，绝不全局排序）</div>
            <textarea
              value={JSON.stringify(spec.argCommutativeFlags, null, 2)}
              onChange={(e) => {
                const value = safeParse(e.target.value, spec.argCommutativeFlags);
                setSpec((cur) => ({ ...cur, argCommutativeFlags: value as string[] }));
              }}
            />
          </div>
        </div>
        <div className="muted">完整规则 JSON：</div>
        <textarea style={{ minHeight: 180 }} value={specText} onChange={(e) => applyText(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <input style={{ flex: 1, minWidth: 220 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="草案说明" />
          <button className="btn" onClick={doDryRun}>干跑（历史动作）</button>
          <button className="btn primary" onClick={saveDraft}>建立草案</button>
        </div>
        {err && <div className="danger-box">{err}</div>}
        {msg && <div className="ok-box">{msg}</div>}
      </div>

      {dry && (
        <div className="panel">
          <h2>干跑结果：命中变化与碰撞反例</h2>
          <div className="row">
            <span className="badge ok">新增合并 {dry.merges.length} 对动作</span>
            <span className={`badge ${dry.collisions.length ? "disputed" : "active"}`}>
              同键动作组 {dry.collisions.length}
            </span>
            <span className={`badge ${dry.dangerousMerges.length ? "disputed" : "active"}`}>
              危险碰撞（同键异输出）{dry.dangerousMerges.length}
            </span>
          </div>
          {dry.dangerousMerges.length > 0 && (
            <div className="danger-box">
              候选规则把输出不同的动作合并到同一 key，命中会拿到错误产物：
              <ul>
                {dry.dangerousMerges.slice(0, 8).map((m, i) => (
                  <li key={i} className="mono">{m.a} ≡ {m.b} → {m.key.slice(0, 18)}…</li>
                ))}
              </ul>
            </div>
          )}
          <h3>同键分组</h3>
          <table>
            <thead><tr><th>新 key</th><th>动作</th><th>结果版本数</th></tr></thead>
            <tbody>
              {dry.collisions.map((c) => (
                <tr key={c.key}>
                  <td className="mono hash">{c.key.slice(0, 20)}…</td>
                  <td className="mono">{c.actionIds.join(", ")}</td>
                  <td className={c.resultHashes.length > 1 ? "diff-diff" : "diff-equal"}>
                    {c.resultHashes.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function safeParse(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

import { useEffect, useState } from "react";
import { api, type DerivationDetail } from "./api.ts";
import type { ActionNode } from "../shared/types.ts";

export function Fingerprint({ action }: { action: ActionNode }) {
  const [detail, setDetail] = useState<DerivationDetail | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr("");
    api
      .derivation(action.importId, action.id)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [action.importId, action.id, action.key]);

  if (err) return <div className="danger-box">无法加载指纹：{err}</div>;
  if (!detail) return <div className="muted">加载指纹组成部分…</div>;

  return (
    <div>
      <div className="kv">
        <span className="k">动作</span>
        <span className="mono">{action.importId}:{action.id}</span>
        <span className="k">Key</span>
        <span className="mono hash">{detail.key}</span>
        <span className="k">结果版本</span>
        <span className="mono hash">{detail.resultHash}</span>
        <span className="k">规则版本</span>
        <span className="mono">v{detail.ruleVersionId}</span>
      </div>

      {detail.envCapture.undeclared.length > 0 && (
        <div className="warn-box">
          未声明环境变量（<b>不进 key</b>，仅风险提示）：
          {detail.envCapture.undeclared
            .map((k) => `${k}=${detail.raw.env?.[k] ?? ""}`)
            .join("，")}
        </div>
      )}
      {detail.warnings.length > 0 &&
        detail.warnings
          .filter((w) => !detail.envCapture.undeclared.some((u) => w.includes(u)))
          .map((w, i) => (
            <div key={i} className="warn-box">{w}</div>
          ))}

      <h3>组成部分（按喂哈希顺序）</h3>
      {detail.components.map((comp) => (
        <details key={comp.component}>
          <summary>
            <span className="mono">{comp.component}</span>{" "}
            <span className="muted">
              {comp.bytes.length / 2} 字节 · {comp.notes[0] ?? "按原始字节编码"}
            </span>
          </summary>
          <div className="body">
            <div className="grid2">
              <div>
                <div className="muted">原始值（清单不可变）</div>
                <pre>{JSON.stringify(comp.raw, null, 2)}</pre>
              </div>
              <div>
                <div className="muted">规范化后（派生记录）</div>
                <pre>{JSON.stringify(comp.normalized, null, 2)}</pre>
              </div>
            </div>
            {comp.notes.length > 0 && (
              <ul className="muted" style={{ margin: "4px 0", paddingLeft: 18 }}>
                {comp.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            )}
            <div className="muted">明确字节编码（hex，长度前缀）</div>
            <pre style={{ maxHeight: 90, overflow: "auto" }}>{comp.bytes}</pre>
          </div>
        </details>
      ))}

      <h3>依赖结果钉住</h3>
      {detail.depPins.length === 0 ? (
        <div className="muted">无依赖动作</div>
      ) : (
        <table>
          <thead>
            <tr><th>依赖</th><th>dep key</th><th>结果版本</th><th>状态</th></tr>
          </thead>
          <tbody>
            {detail.depPins.map((pin) => (
              <tr key={pin.depId}>
                <td className="mono">{pin.depId}</td>
                <td className="mono hash">{pin.depKey.slice(0, 22)}…</td>
                <td className="mono hash">{pin.resultHash.slice(0, 22)}…</td>
                <td>
                  <span className={`badge ${pin.status}`}>{pin.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

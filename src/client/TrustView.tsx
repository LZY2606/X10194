import { useState } from "react";
import { api } from "./api.ts";
import type {
  ActionNode,
  DigestCorrection,
  DistrustRow,
  ImportRow,
} from "../shared/types.ts";

export function TrustView({
  actions,
  imports,
  corrections,
  distrust,
  recovery,
  onChanged,
}: {
  actions: ActionNode[];
  imports: ImportRow[];
  corrections: DigestCorrection[];
  distrust: DistrustRow[];
  recovery: { id: number; event: string; detail: string; at: number }[];
  onChanged: () => void;
}) {
  const [importId, setImportId] = useState(imports[0]?.id ?? 1);
  const inputPaths = [...new Set(actions.map((a) => a.inputs.map((f) => f.path)).flat())].sort();
  const [path, setPath] = useState(inputPaths[0] ?? "");
  const [newDigest, setNewDigest] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [manifestText, setManifestText] = useState('');
  const [crash, setCrash] = useState(false);
  const [importMsg, setImportMsg] = useState("");

  const correct = async () => {
    setErr("");
    setMsg("");
    if (!/^[0-9a-f]{8,}$/i.test(newDigest)) {
      setErr("新摘要需要 hex 字符串");
      return;
    }
    try {
      const r = (await api.correct({ importId, path, newDigest })) as {
        correctionId: number;
        distrustedActions: { actionId: string }[];
      };
      setMsg(`纠正 #${r.correctionId}：${r.distrustedActions.length} 个可达动作失信（共享子图反向传播）`);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const doImport = async () => {
    setImportMsg("");
    try {
      const manifest = JSON.parse(manifestText);
      const r = (await api.importManifest(manifest, crash)) as {
        importId: number;
        rolledBack: boolean;
        invalid: { actionId: string; reason: string }[];
      };
      setImportMsg(
        r.rolledBack
          ? `模拟崩溃：导入 ${r.importId} 停在 pending，可在下方执行崩溃恢复。`
          : `导入 ${r.importId} 已提交；无效动作 ${r.invalid.length} 个。`,
      );
      onChanged();
    } catch (e) {
      setImportMsg("导入失败：" + (e as Error).message);
    }
  };

  return (
    <div>
      <div className="panel">
        <h2>摘要纠正 → 失信传播（只影响可达动作）</h2>
        <div className="row">
          <select value={importId} onChange={(e) => setImportId(Number(e.target.value))}>
            {imports.map((imp) => (
              <option key={imp.id} value={imp.id}>#{imp.id} {imp.manifestId} ({imp.status})</option>
            ))}
          </select>
          <select value={path} onChange={(e) => setPath(e.target.value)}>
            {inputPaths.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input style={{ flex: 1, minWidth: 200 }} placeholder="新的正确摘要（hex）" value={newDigest} onChange={(e) => setNewDigest(e.target.value.trim())} />
          <button className="btn danger" onClick={correct}>纠正并传播</button>
        </div>
        {msg && <div className="ok-box">{msg}</div>}
        {err && <div className="danger-box">{err}</div>}

        <h3>纠正记录（原始清单保持不变）</h3>
        <table>
          <thead><tr><th>#</th><th>导入</th><th>路径</th><th>旧摘要</th><th>新摘要</th></tr></thead>
          <tbody>
            {corrections.map((c) => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>#{c.importId}</td>
                <td className="mono">{c.path}</td>
                <td className="mono hash">{c.oldDigest.slice(0, 16)}…</td>
                <td className="mono hash">{c.newDigest.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>失信动作（DAG 中橙色）</h3>
        {distrust.length === 0 ? (
          <div className="muted">尚无失信动作。</div>
        ) : (
          <table>
            <thead><tr><th>动作</th><th>导入</th><th>根动作</th><th>原因</th></tr></thead>
            <tbody>
              {distrust.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.actionId}</td>
                  <td>#{d.importId}</td>
                  <td className="mono">{d.rootActions}</td>
                  <td>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>导入动作清单（允许乱序；整批事务）</h2>
        <textarea
          value={manifestText}
          onChange={(e) => setManifestText(e.target.value)}
          placeholder='{"manifestId":"x","actions":[{"id":"b","command":"...","deps":["a"],...},{"id":"a",...}]}'
        />
        <div className="row" style={{ marginTop: 8 }}>
          <label className="row">
            <input type="checkbox" checked={crash} onChange={(e) => setCrash(e.target.checked)} />
            提交前模拟崩溃
          </label>
          <button className="btn primary" onClick={doImport}>导入</button>
          <button
            className="btn"
            onClick={async () => {
              const r = await api.recover();
              setImportMsg(`恢复完成：回收 pending ${r.rolledBack.length} 个（${r.rolledBack.join(", ") || "无"}）`);
              onChanged();
            }}
          >
            执行崩溃恢复
          </button>
        </div>
        {importMsg && <div className="warn-box">{importMsg}</div>}
        <h3>导入批次</h3>
        <table>
          <thead><tr><th>#</th><th>manifest</th><th>状态</th><th>动作数</th><th>提交时间</th></tr></thead>
          <tbody>
            {imports.map((imp) => (
              <tr key={imp.id}>
                <td>{imp.id}</td>
                <td className="mono">{imp.manifestId}</td>
                <td><span className={`badge ${imp.status === "committed" ? "active" : imp.status === "pending" ? "draft" : "distrusted"}`}>{imp.status}</span></td>
                <td>{imp.actionCount}</td>
                <td className="muted">{imp.committedAt ? new Date(imp.committedAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>恢复/审计日志</h3>
        <table>
          <thead><tr><th>#</th><th>事件</th><th>详情</th></tr></thead>
          <tbody>
            {recovery.map((ev) => (
              <tr key={ev.id}>
                <td>{ev.id}</td>
                <td className="mono">{ev.event}</td>
                <td>{ev.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState } from "react";
import { api } from "./api.ts";
import type { CacheEntry, Dispute } from "../shared/types.ts";

export function DisputesView({
  entries,
  disputes,
  onChanged,
}: {
  entries: CacheEntry[];
  disputes: Dispute[];
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [resultHash, setResultHash] = useState("");
  const [source, setSource] = useState("remote-cache/drill");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const observe = async () => {
    setErr("");
    setMsg("");
    try {
      const r = (await api.observe({ key, resultHash, source })) as {
        entryId: number;
        disputeId?: number;
      };
      setMsg(
        r.disputeId
          ? `已追加为条目 #${r.entryId}，并与既有观察形成争议 #${r.disputeId}（旧条目保留）`
          : `已追加条目 #${r.entryId}`,
      );
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div>
      <div className="panel">
        <h2>争议条目：同键异输出（绝不最后写入覆盖）</h2>
        {disputes.length === 0 ? (
          <div className="muted">当前没有争议。下面登记异输出观察即可制造争议。</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th><th>key</th><th>首次观察（先到者）</th><th>第二来源</th><th>发现时间</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.id}>
                  <td>{d.id}</td>
                  <td className="mono hash">{d.key.slice(0, 20)}…</td>
                  <td>
                    <div>{d.firstSource}</div>
                    <div className="mono hash">{d.firstResultHash.slice(0, 18)}…</div>
                  </td>
                  <td>
                    <div>{d.secondSource}</div>
                    <div className="mono hash">{d.secondResultHash.slice(0, 18)}…</div>
                  </td>
                  <td className="muted">{new Date(d.observedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>追加缓存观察（离线复盘，不连真实缓存）</h2>
        <div className="row">
          <input style={{ flex: 2, minWidth: 260 }} placeholder="缓存 key（完整 hex）" value={key} onChange={(e) => setKey(e.target.value)} />
          <input style={{ flex: 2, minWidth: 200 }} placeholder="输出结果 hash" value={resultHash} onChange={(e) => setResultHash(e.target.value)} />
          <input style={{ flex: 1, minWidth: 140 }} placeholder="来源" value={source} onChange={(e) => setSource(e.target.value)} />
          <button className="btn primary" onClick={observe}>登记观察</button>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          顺序由自增 seq 保证：先到者永远是 first，后到异输出只会把双方置为 disputed 并追加。
        </div>
        {msg && <div className="ok-box">{msg}</div>}
        {err && <div className="danger-box">{err}</div>}
      </div>

      <div className="panel">
        <h2>全部缓存条目（{entries.length}）</h2>
        <table>
          <thead>
            <tr><th>seq</th><th>状态</th><th>key</th><th>结果 hash</th><th>来源</th><th>时间</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.seq}</td>
                <td><span className={`badge ${e.status}`}>{e.status}</span></td>
                <td className="mono hash">{e.key.slice(0, 18)}…</td>
                <td className="mono hash">{e.resultHash.slice(0, 18)}…</td>
                <td>{e.source}</td>
                <td className="muted">{new Date(e.observedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

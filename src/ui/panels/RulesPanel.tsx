import { useState } from 'react';
import { api, type DryRun, type NormalizationRule, type RuleVersion, type State } from '../client';

export function RulesPanel({
  state,
  refresh,
  setError,
}: {
  state: State;
  refresh: () => Promise<unknown>;
  setError: (e: string | null) => void;
}) {
  const [label, setLabel] = useState('路径与 include 顺序等价');
  const [aliases, setAliases] = useState<{ name: string; from: string; to: string }[]>([
    { name: 'home-root', from: 'C:\\Users\\ci\\project', to: '/home/ci/project' },
  ]);
  const [separator, setSeparator] = useState(true);
  const [unorderedFlags, setUnorderedFlags] = useState('-I');
  const [draft, setDraft] = useState<RuleVersion | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRun | null>(null);

  const buildRules = (): NormalizationRule[] => {
    const rules: NormalizationRule[] = aliases
      .filter((a) => a.from && a.to)
      .map((a) => ({ kind: 'pathAlias' as const, ...a }));
    if (separator) rules.push({ kind: 'pathSeparator', name: 'unix-separator' });
    const flags = unorderedFlags
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (flags.length) rules.push({ kind: 'unorderedFlag', name: 'include-order', flags });
    return rules;
  };

  const makeDraft = async () => {
    try {
      const d = await api.draft(label, buildRules(), state.activeRuleVersion);
      setDraft(d);
      setDryRunResult(await api.dryRun(d.version));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const approve = async () => {
    if (!draft) return;
    await api.approve(draft.version);
    setDraft(null);
    setDryRunResult(null);
    await refresh();
  };

  const rollback = async (v: number) => {
    if (!confirm(`回滚到规则 v${v}？所有指纹将按该版本重算。`)) return;
    await api.rollback(v);
    await refresh();
  };

  return (
    <section>
      <h2>规范化规则草案</h2>
      <p className="hint">
        只能声明明确等价的部分：路径别名、separator、或声明的参数组。不会为了命中率全局排序参数。草案先用历史动作干跑，查看命中变化与碰撞反例，再批准形成新版本。
      </p>

      <div className="form">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="草案名称" />
      </div>

      <h3>路径别名（最长前缀匹配）</h3>
      {aliases.map((a, i) => (
        <div className="form" key={i}>
          <input
            value={a.name}
            onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            placeholder="规则名"
          />
          <input
            value={a.from}
            onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
            placeholder="from（原始前缀）"
          />
          <input
            value={a.to}
            onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
            placeholder="to（规范前缀）"
          />
          <button onClick={() => setAliases(aliases.filter((_, j) => j !== i))}>删除</button>
        </div>
      ))}
      <button
        onClick={() => setAliases([...aliases, { name: `alias-${aliases.length + 1}`, from: '', to: '' }])}
      >
        + 添加别名
      </button>

      <h3>等价选项</h3>
      <label className="check">
        <input type="checkbox" checked={separator} onChange={(e) => setSeparator(e.target.checked)} />
        pathSeparator：将反斜杠视为斜杠（明确声明）
      </label>
      <div className="form">
        <input
          value={unorderedFlags}
          onChange={(e) => setUnorderedFlags(e.target.value)}
          placeholder="允许重排的参数组，如 -I -L（仅这些 flag 的值参与排序）"
        />
      </div>

      <div className="form">
        <button className="primary" onClick={makeDraft}>
          建立草案并干跑历史动作
        </button>
        {draft && (
          <>
            <button className="approve" onClick={approve}>
              批准 v{draft.version}（碰撞 {dryRunResult?.collisions.length ?? 0} 个）
            </button>
            <span className="warn">碰撞存在时批准会使对应条目进入争议状态</span>
          </>
        )}
      </div>

      {dryRunResult && (
        <div className="dryrun">
          <h3>
            干跑结果（基线 v{dryRunResult.baselineVersion} → 草案 v{dryRunResult.ruleVersion}）
          </h3>
          <div className="stats">
            <span className="stat good">新增命中 {dryRunResult.hitsGained}</span>
            <span className="stat bad">丢失命中 {dryRunResult.hitsLost}</span>
            <span className="stat">不变 {dryRunResult.unchanged}</span>
            <span className="stat">参与比较 {dryRunResult.observedActions}</span>
          </div>
          <h4>碰撞反例（同键异输出，禁止直接放行）</h4>
          {dryRunResult.collisions.length === 0 && <p className="hint">无碰撞。</p>}
          {dryRunResult.collisions.map((c, i) => (
            <div key={i} className="collision">
              <code>{c.key.slice(0, 24)}…</code>
              <div>{c.counterexample}</div>
              <div>
                成员：
                {c.members.map((m) => (
                  <span key={`${m.actionId}:${m.resultVersion}`} className="chip">
                    {m.actionId}#v{m.resultVersion}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <h4>键发生变化的动作（前 20 条）</h4>
          <details>
            <summary>{dryRunResult.changes.length} 个动作的 key 改变</summary>
            <table>
              <tbody>
                {dryRunResult.changes.slice(0, 20).map((ch, i) => (
                  <tr key={i}>
                    <td>{ch.actionId}</td>
                    <td>
                      <code>{ch.oldKey.slice(0, 12)}…</code>
                    </td>
                    <td>→</td>
                    <td>
                      <code>{ch.newKey.slice(0, 12)}…</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      <h3>规则版本</h3>
      <table>
        <thead>
          <tr>
            <th>版本</th>
            <th>名称</th>
            <th>状态</th>
            <th>基于</th>
            <th>规则</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.rules.map((r) => (
            <tr key={r.version}>
              <td>v{r.version}</td>
              <td>{r.label}</td>
              <td>
                <span className={`badge ${r.status === 'active' ? 'ok' : ''}`}>{r.status}</span>
              </td>
              <td>{r.parentVersion ? `v${r.parentVersion}` : '—'}</td>
              <td>{r.rules.map((x) => x.kind).join(', ') || '（恒等）'}</td>
              <td>
                {r.status !== 'active' && r.status !== 'draft' && (
                  <button onClick={() => rollback(r.version)}>回滚到此版本</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

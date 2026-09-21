import { useCallback, useEffect, useState } from 'react';
import { client, type ApiState } from './api';
import { DagPanel } from './DagPanel';
import { FingerprintPanel } from './FingerprintPanel';
import { ComparePanel } from './ComparePanel';
import { DisputesPanel } from './DisputesPanel';
import { RulesPanel } from './RulesPanel';

type Tab = 'dag' | 'fingerprint' | 'compare' | 'disputes' | 'rules';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dag', label: '动作 DAG' },
  { id: 'fingerprint', label: '指纹展开' },
  { id: 'compare', label: '命中比较' },
  { id: 'disputes', label: '争议与失信' },
  { id: 'rules', label: '规范化规则' },
];

export function App() {
  const [state, setState] = useState<ApiState | null>(null);
  const [tab, setTab] = useState<Tab>('dag');
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const reload = useCallback(async () => {
    setState(await client.state());
  }, []);

  useEffect(() => {
    reload().catch((e) => setToast({ msg: (e as Error).message, error: true }));
  }, [reload]);

  const notify = useCallback((msg: string, error?: boolean) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const pickAction = (id: string) => {
    setSelected(id);
    setTab('fingerprint');
  };

  return (
    <>
      <header className="app-header">
        <h1>构建指纹舱</h1>
        <div className="sub">
          离线复盘远程构建缓存 key 的每个组成部分 · 原始清单不可变，键与解释皆为派生
          {state && (
            <>
              {' '}· 动作 {state.actions.length} · 争议 {state.disputes.length} · 失信{' '}
              {state.distrusted.length} · 规则 v{state.activeRuleVersion}
            </>
          )}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {!state && <div className="muted">加载中…</div>}
        {state && tab === 'dag' && <DagPanel state={state} onSelect={pickAction} />}
        {state && tab === 'fingerprint' && (
          <FingerprintPanel state={state} selected={selected} onSelect={setSelected} />
        )}
        {state && tab === 'compare' && <ComparePanel state={state} />}
        {state && tab === 'disputes' && (
          <DisputesPanel state={state} reload={reload} notify={notify} />
        )}
        {state && tab === 'rules' && (
          <RulesPanel state={state} notify={notify} onChanged={reload} />
        )}
      </main>

      {toast && <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.msg}</div>}
    </>
  );
}

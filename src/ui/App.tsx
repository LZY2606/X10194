import { useEffect, useMemo, useState } from 'react';
import {
  api,
  importManifest,
  type Comparison,
  type Fingerprint,
  type ObsRow,
  type State,
} from './client';
import { DagPanel } from './panels/DagPanel';
import { FingerprintPanel } from './panels/FingerprintPanel';
import { ComparePanel } from './panels/ComparePanel';
import { DisputesPanel } from './panels/DisputesPanel';
import { DistrustPanel } from './panels/DistrustPanel';
import { RulesPanel } from './panels/RulesPanel';
import { ImportPanel } from './panels/ImportPanel';

const TABS = [
  ['dag', '动作 DAG'],
  ['fingerprint', '指纹展开'],
  ['compare', '命中比较'],
  ['disputes', '争议条目'],
  ['distrust', '失信传播'],
  ['rules', '规范化规则'],
  ['import', '导入清单'],
] as const;

type TabId = (typeof TABS)[number][0];

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('dag');
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [fingerprint, setFingerprint] = useState<Fingerprint | null>(null);
  const [ruleVersionForFp, setRuleVersionForFp] = useState<number | undefined>(undefined);
  const [compareA, setCompareA] = useState<number | null>(null);
  const [compareB, setCompareB] = useState<number | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const refresh = async () => {
    try {
      const s = await api.state();
      setState(s);
      setError(null);
      return s;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const allObservations = useMemo(
    () => state?.actions.flatMap((a) => a.observations) ?? [],
    [state],
  );

  useEffect(() => {
    if (selectedVersion == null) {
      setFingerprint(null);
      return;
    }
    api.fingerprint(selectedVersion, ruleVersionForFp).then(setFingerprint).catch(setError);
  }, [selectedVersion, ruleVersionForFp, state]);

  useEffect(() => {
    if (compareA == null || compareB == null) {
      setComparison(null);
      return;
    }
    api.compare(compareA, compareB).then(setComparison).catch(setError);
  }, [compareA, compareB, state]);

  const pickObs = (label: string, value: number | null, onChange: (v: number) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      <option value="" disabled>
        {label}
      </option>
      {allObservations.map((o: ObsRow) => (
        <option key={o.resultVersion} value={o.resultVersion}>
          #{o.resultVersion} {o.spec.id} ({o.status})
        </option>
      ))}
    </select>
  );

  return (
    <div className="app">
      <header>
        <h1>构建指纹舱</h1>
        <div className="sub">
          离线复盘每个缓存 key 的来源 · 原始清单不可变 · 显式字节编码哈希 · 当前规则 v
          {state?.activeRuleVersion ?? '-'}
        </div>
      </header>

      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <button className="tab ghost" onClick={() => refresh()}>
          刷新
        </button>
        <button
          className="tab ghost danger"
          onClick={async () => {
            if (confirm('重置并重新播种演示数据？')) setState(await api.reset());
          }}
        >
          重置演示
        </button>
      </nav>

      {error && <div className="error">{String(error)}</div>}

      <main>
        {!state && <div>加载中…</div>}
        {state && tab === 'dag' && <DagPanel state={state} />}
        {state && tab === 'fingerprint' && (
          <FingerprintPanel
            state={state}
            picker={pickObs('选择结果版本', selectedVersion, setSelectedVersion)}
            selectedVersion={selectedVersion}
            fingerprint={fingerprint}
            ruleVersionForFp={ruleVersionForFp}
            setRuleVersionForFp={setRuleVersionForFp}
          />
        )}
        {state && tab === 'compare' && (
          <ComparePanel
            state={state}
            pickA={pickObs('结果 A', compareA, setCompareA)}
            pickB={pickObs('结果 B', compareB, setCompareB)}
            comparison={comparison}
          />
        )}
        {state && tab === 'disputes' && <DisputesPanel state={state} />}
        {state && tab === 'distrust' && <DistrustPanel state={state} refresh={refresh} />}
        {state && tab === 'rules' && <RulesPanel state={state} refresh={refresh} setError={setError} />}
        {state && tab === 'import' && (
          <ImportPanel
            onImport={async (text) => {
              await importManifest(text);
              await refresh();
            }}
            setError={setError}
            jobs={state.jobs}
          />
        )}
      </main>
    </div>
  );
}

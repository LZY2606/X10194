import { useState, type ReactNode } from 'react';
import type { Fingerprint, RuleVersion, State } from '../client';

interface NormalizedToken {
  raw: string;
  normalized: string;
  notes: string[];
  group?: string | null;
}
interface EnvComponent {
  name: string;
  present: boolean;
  rawValue: string | null;
  normalizedValue: string | null;
  declared: boolean;
}
interface InputComponent {
  rawPath: string;
  normalizedPath: string;
  digest: string;
  mode: number;
  symlinkTarget: string | null;
  notes: string[];
}
interface DepComponent {
  actionId: string;
  pinnedResultVersion: number;
  outputSetHash: string;
  status: string;
}
interface Explain {
  actionId: string;
  ruleVersion: number;
  command: NormalizedToken;
  argv: NormalizedToken[];
  cwd: NormalizedToken;
  toolchain: { name: string; version: string };
  platform: { os: string; arch: string };
  env: EnvComponent[];
  inputs: InputComponent[];
  deps: DepComponent[];
  status: string;
}

function Section({ title, hash, children }: { title: string; hash?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fp-section">
      <button className="section-head" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} {title}</span>
        {hash && <code className="hash">{hash.slice(0, 16)}…</code>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

const label: Record<string, string> = {
  command: '命令',
  argv: '参数（未声明等价绝不全局排序）',
  cwd: '工作目录',
  toolchain: '工具链',
  platform: '平台属性',
  env: '环境白名单（缺失即语义）',
  inputs: '输入文件摘要 / 可执行位 / symlink',
  deps: '依赖结果版本钉住',
  status: '成败状态',
};

export function FingerprintPanel({
  state,
  picker,
  fingerprint,
  ruleVersionForFp,
  setRuleVersionForFp,
}: {
  state: State;
  picker: ReactNode;
  selectedVersion: number | null;
  fingerprint: Fingerprint | null;
  ruleVersionForFp?: number;
  setRuleVersionForFp: (v: number | undefined) => void;
}) {
  const hashByName = new Map((fingerprint?.components ?? []).map((c) => [c.name, c.hash]));
  const explain = fingerprint?.explain as unknown as Explain | undefined;

  return (
    <section>
      <h2>指纹展开</h2>
      <div className="toolbar">
        {picker}
        <select
          value={ruleVersionForFp ?? ''}
          onChange={(e) => setRuleVersionForFp(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">当前生效规则 v{state.activeRuleVersion}</option>
          {state.rules.map((r: RuleVersion) => (
            <option key={r.version} value={r.version}>
              用规则 v{r.version} 重算
            </option>
          ))}
        </select>
      </div>

      {fingerprint && explain && (
        <>
          <div className="key-box">
            <span className="key-label">fingerprint key</span>
            <code>{fingerprint.key}</code>
          </div>

          {(['command', 'argv', 'cwd', 'toolchain', 'platform', 'env', 'inputs', 'deps', 'status'] as const).map(
            (name) => (
              <Section key={name} title={label[name]} hash={hashByName.get(name)}>
                {name === 'command' && <TokenView tok={explain.command} />}
                {name === 'argv' && (
                  <table>
                    <tbody>
                      {explain.argv.map((t, i) => (
                        <tr key={i}>
                          <td style={{ width: '40%' }}>
                            <code>{t.raw}</code>
                          </td>
                          <td>
                            <TokenView tok={t} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {name === 'cwd' && <TokenView tok={explain.cwd} />}
                {name === 'toolchain' && (
                  <div>
                    {explain.toolchain.name} @ {explain.toolchain.version}
                  </div>
                )}
                {name === 'platform' && (
                  <div>
                    {explain.platform.os} / {explain.platform.arch}
                  </div>
                )}
                {name === 'env' && (
                  <table>
                    <thead>
                      <tr>
                        <th>变量</th>
                        <th>存在</th>
                        <th>值</th>
                        <th>在白名单</th>
                      </tr>
                    </thead>
                    <tbody>
                      {explain.env.map((e) => (
                        <tr key={e.name} className={!e.declared ? 'undeclared' : ''}>
                          <td>{e.name}</td>
                          <td>{e.present ? '是' : '否（缺失）'}</td>
                          <td>{e.present ? e.normalizedValue : '—'}</td>
                          <td>{e.declared ? '是' : <span className="warn">否：未声明环境</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {name === 'inputs' && (
                  <table>
                    <thead>
                      <tr>
                        <th>原始路径</th>
                        <th>规范路径</th>
                        <th>摘要</th>
                        <th>mode</th>
                        <th>symlink 目标</th>
                        <th>规范化说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {explain.inputs.map((f, i) => (
                        <tr key={i}>
                          <td>
                            <code>{f.rawPath}</code>
                          </td>
                          <td>
                            <code>{f.normalizedPath}</code>
                          </td>
                          <td>
                            <code>{f.digest.slice(0, 16)}…</code>
                          </td>
                          <td className={f.mode & 0o111 ? 'mode-exec' : ''}>0o{f.mode.toString(8)}</td>
                          <td>{f.symlinkTarget ? <code>{f.symlinkTarget}</code> : '—'}</td>
                          <td>{f.notes.join('；') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {name === 'deps' && (
                  <table>
                    <thead>
                      <tr>
                        <th>依赖动作</th>
                        <th>钉住结果版本</th>
                        <th>输出集合 hash</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {explain.deps.length === 0 && (
                        <tr>
                          <td colSpan={4}>无依赖</td>
                        </tr>
                      )}
                      {explain.deps.map((d) => (
                        <tr key={d.actionId} className={d.status === 'failed' ? 'failed-row' : ''}>
                          <td>{d.actionId}</td>
                          <td>v{d.pinnedResultVersion}</td>
                          <td>
                            <code>{d.outputSetHash.slice(0, 16)}…</code>
                          </td>
                          <td>{d.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {name === 'status' && <div>{explain.status}</div>}
              </Section>
            ),
          )}
        </>
      )}
      {!fingerprint && <p className="hint">选择一个结果版本以展开它的 key 组成。</p>}
    </section>
  );
}

function TokenView({ tok }: { tok: NormalizedToken }) {
  return (
    <div>
      <div>
        <code>{tok.normalized}</code>
      </div>
      {tok.notes.length > 0 && <div className="notes">{tok.notes.join('；')}</div>}
      {tok.raw !== tok.normalized && <div className="raw">原始：{tok.raw}</div>}
    </div>
  );
}

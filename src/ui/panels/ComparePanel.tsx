import type { ReactNode } from 'react';
import type { Comparison, State } from '../client';

const componentLabel: Record<string, string> = {
  command: '命令',
  argv: '参数',
  cwd: '工作目录',
  toolchain: '工具链',
  platform: '平台',
  env: '环境',
  inputs: '输入',
  deps: '依赖版本',
  status: '状态',
};

export function ComparePanel({
  state,
  pickA,
  pickB,
  comparison,
}: {
  state: State;
  pickA: ReactNode;
  pickB: ReactNode;
  comparison: Comparison | null;
}) {
  void state;
  return (
    <section>
      <h2>命中比较</h2>
      <p className="hint">比较两次动作结果为何命中（key 相同）或未命中（哪个组成部分不同）。</p>
      <div className="toolbar">
        {pickA}
        <span>⇄</span>
        {pickB}
      </div>

      {comparison && (
        <>
          <div className={comparison.verdict === 'hit' ? 'verdict hit' : 'verdict miss'}>
            {comparison.verdict === 'hit' ? '命中 HIT：两个 key 完全一致' : '未命中 MISS：至少一个组成部分不同'}
            <span className="rule-tag">按规则 v{comparison.ruleVersion} 计算</span>
          </div>
          <div className="key-box">
            <div>
              <strong>A</strong> <code>{comparison.keyA}</code>
            </div>
            <div>
              <strong>B</strong> <code>{comparison.keyB}</code>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>组成</th>
                <th>A</th>
                <th>B</th>
                <th>结果</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {comparison.diffs.map((d) => (
                <tr key={d.component} className={d.same ? 'same' : 'diff-row'}>
                  <td>{componentLabel[d.component] ?? d.component}</td>
                  <td className="val">{d.a || '—'}</td>
                  <td className="val">{d.b || '—'}</td>
                  <td>{d.same ? '相同' : '不同'}</td>
                  <td>{d.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {!comparison && <p className="hint">请在上方选择两个结果版本。</p>}
    </section>
  );
}

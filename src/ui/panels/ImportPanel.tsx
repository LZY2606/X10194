import { useState } from 'react';

export function ImportPanel({
  onImport,
  setError,
  jobs,
}: {
  onImport: (text: string) => Promise<void>;
  setError: (e: string | null) => void;
  jobs: { jobId: string; status: string; totalChunks: number; receivedChunks: number }[];
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const sample = JSON.stringify(
    {
      manifestId: 'm-example',
      importedAt: 1700_100_000,
      actions: [
        {
          id: 'example_action',
          observedAt: 4000,
          command: '/opt/toolchain/bin/gcc',
          argv: ['-c', 'src/example.c', '-o', 'build/example.o'],
          cwd: '/home/ci/project',
          env: { PATH: '/usr/bin:/opt/toolchain/bin' },
          envWhitelist: ['PATH', 'CC'],
          toolchain: { name: 'gcc', version: '13.2.0' },
          platform: { os: 'linux', arch: 'x64' },
          inputs: [{ path: 'src/example.c', digest: '00'.repeat(32), mode: 420 }],
          deps: [],
          outputs: [{ path: 'build/example.o', digest: '11'.repeat(32), mode: 420 }],
          status: 'success',
        },
      ],
    },
    null,
    2,
  );

  const doImport = async () => {
    setBusy(true);
    try {
      await onImport(text);
      setText('');
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>导入构建动作清单</h2>
      <p className="hint">
        原始清单只追加、不可变；规范化键与解释是派生记录。清单按分片持久化，全部到齐后再在单一事务内派生——崩溃后可继续提交缺失分片并重新 finalize。
        乱序动作以 observedAt 确定依赖钉点。
      </p>
      <textarea
        rows={16}
        style={{ width: '100%', fontFamily: 'monospace' }}
        placeholder="粘贴 Manifest JSON"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="form">
        <button className="primary" disabled={busy || !text.trim()} onClick={doImport}>
          {busy ? '导入中…' : '分片导入并派生'}
        </button>
        <button onClick={() => setText(sample)}>填入示例</button>
      </div>

      <h3>导入作业（崩溃恢复）</h3>
      <table>
        <thead>
          <tr>
            <th>作业</th>
            <th>状态</th>
            <th>分片进度</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.jobId}>
              <td>
                <code>{j.jobId}</code>
              </td>
              <td>{j.status === 'finalized' ? <span className="badge ok">已完成</span> : <span className="badge danger">接收中（可续传）</span>}</td>
              <td>
                {j.receivedChunks}/{j.totalChunks}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

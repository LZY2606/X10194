export interface ObsRow {
  resultVersion: number;
  manifestId: string;
  observedAt: number;
  status: 'success' | 'failed';
  key: string | null;
  ruleVersion: number | null;
  outputSetHash: string | null;
  trusted: boolean;
  distrustReason: string | null;
  spec: {
    id: string;
    observedAt: number;
    command: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    envWhitelist: string[];
    toolchain: { name: string; version: string };
    platform: { os: string; arch: string };
    inputs: { path: string; digest: string; mode: number; symlinkTarget?: string | null }[];
    deps: string[];
    outputs: { path: string; digest: string; mode: number; symlinkTarget?: string | null }[];
    status: 'success' | 'failed';
    errorText?: string | null;
  };
  pinned: { actionId: string; resultVersion: number; outputSetHash: string; status: 'success' | 'failed' }[];
  firstOrder: number;
}

export interface ActionRow {
  actionId: string;
  command: string;
  argv: string[];
  cwd: string;
  envWhitelist: string[];
  deps: string[];
  latestResultVersion: number | null;
  trusted: boolean;
  distrustReason: string | null;
  observations: ObsRow[];
}

export interface DisputeRow {
  id: number;
  ruleVersion: number;
  key: string;
  firstResultVersion: number;
  secondResultVersion: number;
  firstActionId: string;
  secondActionId: string;
  firstOutputHash: string;
  secondOutputHash: string;
  firstObservedAt: number;
  secondObservedAt: number;
  firstManifestId: string;
  secondManifestId: string;
  status: 'open' | 'resolved';
  note: string;
}

export interface CorrectionRow {
  id: number;
  actionId: string;
  inputPath: string;
  badDigest: string;
  correctDigest: string;
  createdAt: number;
  affectedActions: string[];
}

export interface RuleVersion {
  version: number;
  label: string;
  status: 'active' | 'draft' | 'archived';
  parentVersion: number | null;
  rules: NormalizationRule[];
  createdAt: number;
  approvedAt?: number | null;
}

export type NormalizationRule =
  | { kind: 'pathAlias'; name: string; from: string; to: string }
  | { kind: 'pathSeparator'; name: string }
  | { kind: 'unorderedFlag'; name: string; flags: string[] };

export interface State {
  activeRuleVersion: number;
  rules: RuleVersion[];
  dag: { nodes: { id: string; status: 'success' | 'failed'; trusted: boolean }[]; edges: { from: string; to: string }[] };
  actions: ActionRow[];
  disputes: DisputeRow[];
  corrections: CorrectionRow[];
  jobs: { jobId: string; status: string; totalChunks: number; receivedChunks: number }[];
  audit: { id: number; at: number; kind: string; detail: string }[];
}

export interface ComponentHash {
  name: string;
  hash: string;
}

export interface Fingerprint {
  key: string;
  components: ComponentHash[];
  explain: Record<string, unknown>;
}

export interface Comparison {
  actionA: string;
  actionB: string;
  verdict: 'hit' | 'miss';
  keyA: string;
  keyB: string;
  ruleVersion: number;
  diffs: { component: string; same: boolean; a: string; b: string; detail: string }[];
}

export interface DryRun {
  ruleVersion: number;
  baselineVersion: number;
  observedActions: number;
  hitsGained: number;
  hitsLost: number;
  unchanged: number;
  changes: { actionId: string; oldKey: string; newKey: string }[];
  collisions: {
    key: string;
    outputSetHashes: string[];
    members: { actionId: string; resultVersion: number }[];
    counterexample: string;
  }[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  state: () => req<State>('/api/state'),
  fingerprint: (resultVersion: number, ruleVersion?: number) =>
    req<Fingerprint>(
      `/api/fingerprint?resultVersion=${resultVersion}${ruleVersion ? `&ruleVersion=${ruleVersion}` : ''}`,
    ),
  compare: (a: number, b: number, ruleVersion?: number) =>
    req<Comparison>(
      `/api/compare?a=${a}&b=${b}${ruleVersion ? `&ruleVersion=${ruleVersion}` : ''}`,
    ),
  importStart: (jobId: string, totalChunks: number) =>
    req<unknown>('/api/import/start', { method: 'POST', body: JSON.stringify({ jobId, totalChunks }) }),
  importChunk: (jobId: string, chunkIndex: number, payload: string) =>
    req<unknown>('/api/import/chunk', { method: 'POST', body: JSON.stringify({ jobId, chunkIndex, payload }) }),
  importFinalize: (jobId: string) =>
    req<unknown>('/api/import/finalize', { method: 'POST', body: JSON.stringify({ jobId }) }),
  correction: (actionId: string, inputPath: string, badDigest: string, correctDigest: string) =>
    req<CorrectionRow>('/api/corrections', {
      method: 'POST',
      body: JSON.stringify({ actionId, inputPath, badDigest, correctDigest }),
    }),
  draft: (label: string, rules: NormalizationRule[], baseVersion?: number) =>
    req<RuleVersion>('/api/rules/draft', {
      method: 'POST',
      body: JSON.stringify({ label, rules, baseVersion }),
    }),
  dryRun: (version: number) => req<DryRun>(`/api/rules/dryrun?version=${version}`),
  approve: (version: number) =>
    req<RuleVersion>('/api/rules/approve', { method: 'POST', body: JSON.stringify({ version }) }),
  rollback: (version: number) =>
    req<RuleVersion>('/api/rules/rollback', { method: 'POST', body: JSON.stringify({ version }) }),
  reset: () => req<State>('/api/reset', { method: 'POST' }),
};

export async function importManifest(jsonText: string): Promise<void> {
  const job = JSON.parse(jsonText) as { manifestId: string };
  const jobId = `ui:${job.manifestId}:${Date.now()}`;
  const chunkSize = 16 * 1024;
  const chunks: string[] = [];
  for (let i = 0; i < jsonText.length; i += chunkSize) chunks.push(jsonText.slice(i, i + chunkSize));
  await api.importStart(jobId, chunks.length);
  for (let i = 0; i < chunks.length; i++) await api.importChunk(jobId, i, chunks[i]);
  await api.importFinalize(jobId);
}

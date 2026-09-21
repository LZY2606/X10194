import type { Fingerprint, FingerprintComparison, RuleSpec } from '../core/types';

export interface ApiState {
  activeRuleVersion: number;
  batches: Array<{ batch_id: string; received_at: string; status: string; ord: number }>;
  actions: Array<{ id: string; manifest: import('../core/types').ActionManifest }>;
  fingerprints: Fingerprint[];
  edges: Array<{ from: string; to: string; declared: boolean }>;
  entries: Array<{
    id: number;
    actionId: string;
    key: string;
    outputHash: string;
    source: string;
    observedAt: string;
  }>;
  disputes: Array<{
    id: number;
    key: string;
    status: string;
    resolutionNote: string | null;
    firstSeen: string;
    parties: Array<{
      ord: number;
      actionId: string;
      outputHash: string;
      source: string;
      observedAt: string;
    }>;
  }>;
  corrections: Array<{
    id: number;
    path: string;
    oldAlgo: string;
    oldDigest: string;
    newAlgo: string;
    newDigest: string;
    reason: string;
    createdAt: string;
  }>;
  distrusted: string[];
  distrustedByCorrection: Record<string, string[]>;
  rules: Array<{ version: number; spec: RuleSpec; note: string; createdAt: string }>;
  ruleEvents: Array<{
    at: string;
    kind: string;
    fromVersion: number | null;
    toVersion: number;
    detail: string;
  }>;
  draft: RuleSpec;
}

export interface DryRun {
  ruleVersion: number;
  changedKeys: Array<{ actionId: string; oldKey: string; newKey: string; outputHash: string }>;
  collisions: Array<{
    key: string;
    outputGroups: Array<{ outputHash: string; actionIds: string[] }>;
  }>;
  newBenignHits: Array<{ key: string; actionIds: string[]; outputHash: string }>;
  totalActions: number;
}

async function postJson(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败 ${res.status}`);
  return data;
}

export const client = {
  state: () => fetch('/api/state').then((r) => r.json() as Promise<ApiState>),
  compare: (left: string, right: string) =>
    fetch(`/api/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`).then(
      (r) => r.json() as Promise<FingerprintComparison>,
    ),
  saveDraft: (draft: RuleSpec) => postJson('/api/draft', draft),
  dryRun: (draft: RuleSpec) => postJson('/api/draft/dry-run', draft) as Promise<DryRun>,
  approve: (note: string) => postJson('/api/rules/approve', { note }),
  rollback: (version: number, note: string) =>
    postJson('/api/rules/rollback', { version, note }),
  correct: (body: {
    path: string;
    newAlgo: string;
    newDigest: string;
    reason: string;
  }) => postJson('/api/corrections', body),
  importBatch: (batch: unknown) => postJson('/api/import', batch),
  resolveDispute: (key: string, note: string) =>
    postJson(`/api/disputes/${encodeURIComponent(key)}/resolve`, { note }),
};

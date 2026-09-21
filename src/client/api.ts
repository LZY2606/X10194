import type {
  ActionNode,
  CompareResult,
  CacheEntry,
  DigestCorrection,
  Dispute,
  DistrustRow,
  DryRunResult,
  ImportRow,
  KeyDerivation,
  RawAction,
  RuleSpec,
  RuleVersion,
} from "../shared/types.ts";

export interface FullState {
  rules: RuleVersion[];
  imports: ImportRow[];
  actions: ActionNode[];
  entries: CacheEntry[];
  disputes: Dispute[];
  corrections: DigestCorrection[];
  distrust: DistrustRow[];
  recovery: { id: number; event: string; detail: string; at: number }[];
}

export interface DerivationDetail extends KeyDerivation {
  raw: RawAction;
  envCapture: { captured: Record<string, string>; undeclared: string[] };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
    body: init?.body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  state: () => request<FullState>("/api/state"),
  importManifest: (manifest: unknown, crashBeforeCommit = false) =>
    request<unknown>("/api/imports", {
      method: "POST",
      body: JSON.stringify({ manifest, crashBeforeCommit }),
    }),
  resetDemo: () => request<{ ok: boolean }>("/api/reset-demo", { method: "POST" }),
  recover: () => request<{ pendingBefore: number; rolledBack: number[] }>("/api/recover", {
    method: "POST",
  }),
  derivation: (importId: number, actionId: string) =>
    request<DerivationDetail>(`/api/derivation?importId=${importId}&actionId=${actionId}`),
  compare: (a: { importId: number; actionId: string }, b: { importId: number; actionId: string }) =>
    request<CompareResult>("/api/compare", { method: "POST", body: JSON.stringify({ a, b }) }),
  observe: (body: { key: string; resultHash: string; source: string }) =>
    request<unknown>("/api/entries/observe", { method: "POST", body: JSON.stringify(body) }),
  correct: (body: { importId: number; path: string; newDigest: string }) =>
    request<unknown>("/api/corrections", { method: "POST", body: JSON.stringify(body) }),
  createDraft: (spec: RuleSpec, note: string) =>
    request<RuleVersion>("/api/rules/drafts", {
      method: "POST",
      body: JSON.stringify({ spec, note }),
    }),
  approve: (id: number) => request<RuleVersion>(`/api/rules/${id}/approve`, { method: "POST" }),
  rollback: (id: number) => request<RuleVersion>(`/api/rules/${id}/rollback`, { method: "POST" }),
  dryRun: (spec: RuleSpec) =>
    request<DryRunResult>("/api/rules/dry-run", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
};

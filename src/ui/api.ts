export type Snapshot = any;

async function request(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}

export const api = {
  state: () => request("/api/state"),
  seed: () => request("/api/seed"),
  importManifest: (manifest: unknown) => request("/api/import", { manifest }),
  observe: (entry: unknown) => request("/api/cache/observe", entry),
  correct: (payload: unknown) => request("/api/correct-input", payload),
  templateDraft: () => request("/api/rules/template-draft"),
  dryRun: (version: number) => request(`/api/rules/dry-run/${version}`),
  approve: (version: number) => request(`/api/rules/approve/${version}`),
  rollback: (version: number) => request(`/api/rules/rollback/${version}`),
  compare: (left: { manifestId: string; actionId: string }, right: { manifestId: string; actionId: string }) =>
    request("/api/compare", { left, right }),
};

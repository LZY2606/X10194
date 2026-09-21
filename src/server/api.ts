import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import { Store } from './store';
import { SEED_MANIFESTS } from './seed';
import type { NormalizationRule } from '../core/types';

export const DB_PATH = process.env.BFV_DB_PATH ?? 'data/fingerprint-vault.sqlite';

let storeSingleton: Store | null = null;

export function getStore(dbPath: string = DB_PATH): Store {
  if (!storeSingleton) {
    storeSingleton = new Store(dbPath);
    if (!process.env.BFV_NO_SEED) seedIfEmpty(storeSingleton);
  }
  return storeSingleton;
}

/** Import seed manifests through the normal chunked pipeline. */
export function seedIfEmpty(store: Store): void {
  const state = store.getState();
  if (state.actions.length > 0) return;
  for (const manifest of SEED_MANIFESTS) {
    const json = JSON.stringify(manifest);
    const jobId = `seed:${manifest.manifestId}`;
    const chunks = chunkString(json, 32 * 1024);
    store.startImport(jobId, chunks.length);
    chunks.forEach((c, i) => store.putChunk(jobId, i, c));
    store.finalizeImport(jobId);
  }
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

async function readBody(req: { on: Function }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function createApiPlugin(): Plugin {
  return {
    name: 'fingerprint-vault-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/')) return next();
        try {
          const store = getStore();
          const route = `${req.method ?? 'GET'} ${url.pathname}`;

          if (route === 'GET /api/state') return send(res, 200, store.getState());

          if (route === 'GET /api/fingerprint') {
            const version = Number(url.searchParams.get('resultVersion'));
            const rv = url.searchParams.get('ruleVersion');
            return send(res, 200, store.getFingerprint(version, rv ? Number(rv) : undefined));
          }

          if (route === 'GET /api/compare') {
            const a = Number(url.searchParams.get('a'));
            const b = Number(url.searchParams.get('b'));
            const rv = url.searchParams.get('ruleVersion');
            return send(res, 200, store.compare(a, b, rv ? Number(rv) : undefined));
          }

          if (route === 'POST /api/import/start') {
            const body = JSON.parse(await readBody(req)) as { jobId: string; totalChunks: number };
            return send(res, 200, store.startImport(body.jobId, body.totalChunks));
          }
          if (route === 'POST /api/import/chunk') {
            const body = JSON.parse(await readBody(req)) as {
              jobId: string;
              chunkIndex: number;
              payload: string;
            };
            return send(res, 200, store.putChunk(body.jobId, body.chunkIndex, body.payload));
          }
          if (route === 'POST /api/import/finalize') {
            const body = JSON.parse(await readBody(req)) as { jobId: string };
            return send(res, 200, store.finalizeImport(body.jobId));
          }

          if (route === 'POST /api/corrections') {
            const body = JSON.parse(await readBody(req)) as {
              actionId: string;
              inputPath: string;
              badDigest: string;
              correctDigest: string;
            };
            return send(res, 200, store.recordCorrection(body.actionId, body.inputPath, body.badDigest, body.correctDigest));
          }

          if (route === 'POST /api/rules/draft') {
            const body = JSON.parse(await readBody(req)) as {
              label: string;
              rules: NormalizationRule[];
              baseVersion?: number;
            };
            return send(res, 200, store.createDraft(body.label, body.rules, body.baseVersion));
          }
          if (route === 'GET /api/rules/dryrun') {
            const version = Number(url.searchParams.get('version'));
            return send(res, 200, store.dryRunDraft(version));
          }
          if (route === 'POST /api/rules/approve') {
            const body = JSON.parse(await readBody(req)) as { version: number };
            return send(res, 200, store.approveDraft(body.version));
          }
          if (route === 'POST /api/rules/rollback') {
            const body = JSON.parse(await readBody(req)) as { version: number };
            return send(res, 200, store.rollbackRule(body.version));
          }

          if (route === 'POST /api/reset') {
            store.resetAll();
            seedIfEmpty(store);
            return send(res, 200, store.getState());
          }

          return send(res, 404, { error: `未知接口 ${route}` });
        } catch (e) {
          return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}

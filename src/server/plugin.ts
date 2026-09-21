// Vite 插件：把指纹舱 API 挂到 dev server 上（/api/*），浏览器与 Node 使用同一份 SQLite 数据。
import type { Plugin } from 'vite';
import { createServer } from 'node:http';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { Chamber } from './chamber';
import { seedChamber } from './seed';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), '.chamber-data');
const DB_PATH = join(DATA_DIR, 'chamber.sqlite');

let chamberSingleton: Chamber | null = null;

export function getChamber(): Chamber {
  if (!chamberSingleton) {
    chamberSingleton = new Chamber(DB_PATH);
    if (chamberSingleton.state().actions.length === 0) {
      seedChamber(chamberSingleton);
    }
  }
  return chamberSingleton;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function chamberApiHandler(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/')) return false;
  const chamber = getChamber();

  const handle = (fn: () => unknown): boolean => {
    try {
      const result = fn();
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };

  const route = url.pathname.slice('/api/'.length);

  if (req.method === 'GET' && route === 'state') return handle(() => chamber.state());

  if (req.method === 'POST' && route === 'import/manifest') {
    void readJson(req).then((body) => handle(() => chamber.importManifest(body))).catch((e) => send(res, 400, { error: String(e) }));
    return true;
  }
  if (req.method === 'POST' && route === 'import/begin') {
    void readJson(req).then((body) => handle(() => { chamber.beginImport(body.manifestId, body.importedAt, body.total); return { ok: true }; }));
    return true;
  }
  if (req.method === 'POST' && route === 'import/action') {
    void readJson(req).then((body) => handle(() => { chamber.importAction(body.manifestId, body.seq, body.action); return { ok: true }; }));
    return true;
  }
  if (req.method === 'POST' && route === 'import/finish') {
    void readJson(req).then((body) => handle(() => { chamber.finishImport(body.manifestId); return { ok: true }; }));
    return true;
  }
  if (req.method === 'GET' && route === 'recovery') return handle(() => ({ pending: chamber.recoveryStatus() }));

  if (req.method === 'POST' && route === 'cache/observe') {
    void readJson(req).then((body) => handle(() => chamber.observeCacheEntry(body)));
    return true;
  }
  if (req.method === 'POST' && route === 'corrections') {
    void readJson(req).then((body) => handle(() => chamber.correctDigest(body)));
    return true;
  }
  if (req.method === 'POST' && route === 'rules/draft') {
    void readJson(req).then((body) => ({ id: chamber.createDraft(body.rules, body.note ?? '') }))
      .then((r) => send(res, 200, r)).catch((e) => send(res, 400, { error: String(e) }));
    return true;
  }
  if (req.method === 'POST' && route === 'rules/approve') {
    void readJson(req).then((body) => handle(() => { chamber.approveDraft(body.versionId, body.note); return { ok: true }; }));
    return true;
  }
  if (req.method === 'POST' && route === 'rules/rollback') {
    void readJson(req).then((body) => ({ id: chamber.rollbackTo(body.versionId, body.note) }))
      .then((r) => send(res, 200, r)).catch((e) => send(res, 400, { error: String(e) }));
    return true;
  }
  if (req.method === 'POST' && route === 'rules/dry-run') {
    void readJson(req).then((body) => handle(() => chamber.dryRunDraft(body.versionId)));
    return true;
  }
  if (req.method === 'POST' && route === 'compare') {
    void readJson(req).then((body) => handle(() => chamber.compare(body.actionA, body.actionB)));
    return true;
  }
  if (req.method === 'POST' && route === 'reset') {
    // 演示用：清空数据库并重新播种
    chamberSingleton = null;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    getChamber();
    send(res, 200, { ok: true });
    return true;
  }

  send(res, 404, { error: `未知 API: ${route}` });
  return true;
}

/** 供测试直接使用（不走 Vite） */
export function startStandaloneApi(port: number, chamber?: Chamber) {
  if (chamber) chamberSingleton = chamber;
  return createServer((req, res) => {
    if (chamberApiHandler(req, res)) return;
    res.statusCode = 404;
    res.end();
  }).listen(port);
}

export function chamberApiPlugin(): Plugin {
  return {
    name: 'chamber-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (chamberApiHandler(req, res)) return;
        next();
      });
    },
  };
}

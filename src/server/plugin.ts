// Vite dev 中间件：将 /api/* 直连 SQLite 服务层（不连接真实缓存服务）。
import type { Plugin, ViteDevServer } from "vite";
import { getDb, setDbPath, resetDb } from "./db.ts";
import { seedIfEmpty } from "./seed.ts";
import {
  approveDraft,
  compareActions,
  correctDigest,
  createDraft,
  dryRun,
  getDerivation,
  importManifest,
  listActions,
  listCorrections,
  listDisputes,
  listDistrust,
  listEntries,
  listImports,
  listRecoveryEvents,
  listRuleVersions,
  lookupHit,
  observeEntry,
  rollbackTo,
} from "./store.ts";

setDbPath(process.env.FINGERPRINT_DB ?? "./data/fingerprint.db");

interface JsonResponseInit {
  status?: number;
}

function json(res: import("node:http").ServerResponse, body: unknown, init: JsonResponseInit = {}) {
  res.statusCode = init.status ?? 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

export function apiPlugin(): Plugin {
  return {
    name: "fingerprint-vault-api",
    configureServer(server) {
      getDb();
      seedIfEmpty();

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/")) return next();
        try {
          const route = url.pathname.slice("/api/".length);
          const method = req.method ?? "GET";

          if (method === "GET" && route === "state") {
            return json(res, {
              rules: listRuleVersions(),
              imports: listImports(),
              actions: listActions(),
              entries: listEntries(),
              disputes: listDisputes(),
              corrections: listCorrections(),
              distrust: listDistrust(),
              recovery: listRecoveryEvents(),
            });
          }
          if (method === "POST" && route === "imports") {
            const body = (await readBody(req)) as { manifest: unknown; crashBeforeCommit?: boolean };
            const result = importManifest(body.manifest as never, {
              crashBeforeCommit: body.crashBeforeCommit,
            });
            return json(res, result);
          }
          if (method === "POST" && route === "recover") {
            const db = getDb();
            const before = (
              db.prepare("SELECT COUNT(*) AS n FROM imports WHERE status = 'pending'").get() as {
                n: number;
              }
            ).n;
            const { rolledBack } = await import("./db.ts").then((m) => m.recover(db));
            return json(res, { pendingBefore: before, rolledBack });
          }
          if (method === "POST" && route === "reset-demo") {
            resetDb(process.env.FINGERPRINT_DB ?? "./data/fingerprint.db");
            getDb();
            seedIfEmpty();
            return json(res, { ok: true });
          }
          if (method === "GET" && route === "derivation") {
            const importId = Number(url.searchParams.get("importId"));
            const actionId = url.searchParams.get("actionId") ?? "";
            const ruleVersionId = url.searchParams.get("ruleVersionId");
            return json(
              res,
              getDerivation(importId, actionId, ruleVersionId ? Number(ruleVersionId) : undefined),
            );
          }
          if (method === "GET" && route === "hit") {
            const importId = Number(url.searchParams.get("importId"));
            const actionId = url.searchParams.get("actionId") ?? "";
            return json(res, lookupHit(actionId, importId));
          }
          if (method === "POST" && route === "compare") {
            const body = (await readBody(req)) as {
              a: { importId: number; actionId: string };
              b: { importId: number; actionId: string };
            };
            return json(res, compareActions(body.a, body.b));
          }
          if (method === "POST" && route === "entries/observe") {
            const body = (await readBody(req)) as {
              key: string;
              ruleVersionId?: number;
              resultHash: string;
              source: string;
            };
            return json(
              res,
              observeEntry({
                key: body.key,
                ruleVersionId:
                  body.ruleVersionId ??
                  (listRuleVersions().filter((r) => r.status === "approved").at(-1)?.id ?? 1),
                resultHash: body.resultHash,
                source: body.source,
              }),
            );
          }
          if (method === "POST" && route === "corrections") {
            const body = (await readBody(req)) as {
              importId: number;
              path: string;
              newDigest: string;
            };
            return json(res, correctDigest(body));
          }
          if (method === "POST" && route === "rules/drafts") {
            const body = (await readBody(req)) as { spec: unknown; note: string };
            return json(res, createDraft(body.spec as never, body.note));
          }
          if (method === "POST" && route.startsWith("rules/") && route.endsWith("/approve")) {
            const id = Number(route.split("/")[1]);
            return json(res, approveDraft(id));
          }
          if (method === "POST" && route.startsWith("rules/") && route.endsWith("/rollback")) {
            const id = Number(route.split("/")[1]);
            return json(res, rollbackTo(id));
          }
          if (method === "POST" && route === "rules/dry-run") {
            const body = (await readBody(req)) as { spec: unknown };
            return json(res, dryRun(body.spec as never));
          }
          res.statusCode = 404;
          return res.end("not found");
        } catch (err) {
          return json(
            res,
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      });
    },
  };
}

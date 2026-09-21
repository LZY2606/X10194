import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./db.js";
import { seedDemo, demoDraftRules } from "./seed.js";
import { VaultStore } from "./store.js";

const databasePath = process.env.FINGERPRINT_DB
  ? resolve(process.env.FINGERPRINT_DB)
  : resolve(process.cwd(), "data/fingerprint-vault.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const store = new VaultStore(openDatabase(databasePath));

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function handleApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (request.method === "GET" && path === "/api/state") return sendJson(response, 200, store.snapshot());
    if (request.method === "POST" && path === "/api/seed") {
      const draft = demoDraftRules();
      const result = seedDemo(store);
      if (result.seeded) store.createDraft(draft.rules, draft.description);
      return sendJson(response, 200, { ...result, state: store.snapshot() });
    }
    if (request.method === "POST" && path === "/api/import") {
      const body = await readJson(request);
      const result = store.importManifest(body.manifest);
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && path === "/api/cache/observe") {
      return sendJson(response, 200, store.observeCache(await readJson(request)));
    }
    if (request.method === "POST" && path === "/api/correct-input") {
      const body = await readJson(request);
      return sendJson(response, 200, store.correctInput(body.manifestId, body.inputId, body.oldDigest, body.newDigest));
    }
    if (request.method === "POST" && path === "/api/rules/draft") {
      const body = await readJson(request);
      return sendJson(response, 200, store.createDraft(body.rules, body.description ?? "规则草案"));
    }
    if (request.method === "POST" && path === "/api/rules/template-draft") {
      const draft = demoDraftRules();
      return sendJson(response, 200, store.createDraft(draft.rules, draft.description));
    }
    if (request.method === "POST" && /^\/api\/rules\/dry-run\/\d+$/.test(path)) {
      return sendJson(response, 200, store.dryRun(Number(path.split("/").pop())));
    }
    if (request.method === "POST" && /^\/api\/rules\/approve\/\d+$/.test(path)) {
      return sendJson(response, 200, store.approveDraft(Number(path.split("/").pop())));
    }
    if (request.method === "POST" && /^\/api\/rules\/rollback\/\d+$/.test(path)) {
      return sendJson(response, 200, store.rollbackTo(Number(path.split("/").pop())));
    }
    if (request.method === "POST" && path === "/api/compare") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        store.compareActions(
          body.left.manifestId,
          body.left.actionId,
          body.right.manifestId,
          body.right.actionId,
        ),
      );
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function apiPlugin(): Plugin {
  return {
    name: "fingerprint-vault-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/api/")) void handleApi(request, response);
        else next();
      });
    },
  };
}

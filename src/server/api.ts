import express from 'express';
import type { ServerResponse } from 'node:http';
import { VaultService } from './vault';
import type { ImportBatch, RuleSpec } from '../core/types';

/** 把 Map 等结构序列化为普通 JSON 数组，供前端直接消费 */
function stateJson(service: VaultService) {
  const s = service.getState();
  return {
    activeRuleVersion: s.activeRuleVersion,
    batches: s.batches,
    actions: [...s.actions.entries()].map(([id, manifest]) => ({ id, manifest })),
    fingerprints: [...s.fingerprints.values()],
    edges: [...s.actions.values()].flatMap((a) =>
      a.deps.map((dep) => ({ from: a.id, to: dep, declared: s.actions.has(dep) })),
    ),
    entries: s.entries,
    disputes: s.disputes,
    corrections: s.corrections,
    distrusted: s.distrusted,
    distrustedByCorrection: s.distrustedByCorrection,
    rules: s.rules,
    ruleEvents: s.ruleEvents,
    draft: service.getDraft(),
  };
}

export function createApi(service: VaultService) {
  const api = express.Router();
  api.use(express.json({ limit: '4mb' }));

  api.get('/state', (_req, res) => {
    res.json(stateJson(service));
  });

  api.post('/import', (req, res) => {
    try {
      const body = req.body as ImportBatch;
      if (!body?.batchId || !Array.isArray(body.actions)) {
        res.status(400).json({ error: '需要 { batchId, receivedAt, actions[] }' });
        return;
      }
      const result = service.importBatch({
        batchId: body.batchId,
        receivedAt: body.receivedAt ?? new Date().toISOString(),
        actions: body.actions,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.get('/compare', (req, res) => {
    try {
      const left = String(req.query.left);
      const right = String(req.query.right);
      res.json(service.compare(left, right));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.post('/draft', (req, res) => {
    res.json(service.saveDraft(req.body as RuleSpec));
  });

  api.post('/draft/dry-run', (req, res) => {
    const draft = (req.body as RuleSpec) ?? service.getDraft();
    res.json(service.dryRun(draft));
  });

  api.post('/rules/approve', (req, res) => {
    const note = String(req.body?.note ?? '');
    res.json(service.approveDraft(note));
  });

  api.post('/rules/rollback', (req, res) => {
    try {
      const version = Number(req.body?.version);
      service.rollbackTo(version, String(req.body?.note ?? ''));
      res.json({ ok: true, activeRuleVersion: service.activeRuleVersion() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.post('/corrections', (req, res) => {
    try {
      const { path, newAlgo, newDigest, reason } = req.body ?? {};
      const result = service.addCorrection({
        path: String(path),
        newAlgo: String(newAlgo ?? 'sha256'),
        newDigest: String(newDigest),
        reason: String(reason ?? '人工纠正'),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.post('/disputes/:key/resolve', (req, res) => {
    service.resolveDispute(String(req.params.key), String(req.body?.note ?? ''));
    res.json({ ok: true });
  });

  api.post('/recover', (_req, res) => {
    res.json(service.recoverPending());
  });

  return api;
}

export function createApp(service: VaultService, viteMiddleware?: (req: any, res: ServerResponse, next: () => void) => void) {
  const app = express();
  app.use('/api', createApi(service));
  if (viteMiddleware) app.use(viteMiddleware);
  return app;
}

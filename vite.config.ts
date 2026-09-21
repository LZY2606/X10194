import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/server/db';
import { VaultService } from './src/server/vault';
import { createApi } from './src/server/api';
import { buildSeedBatches, SEEDED_CORRECTION } from './src/server/seed';

const DB_PATH =
  process.env.VAULT_DB ??
  fileURLToPath(new URL('./data/vault.db', import.meta.url));

function vaultPlugin(): PluginOption {
  return {
    name: 'build-fingerprint-vault-api',
    configureServer(server) {
      const db = openDb(DB_PATH);
      const service = new VaultService(db);

      // 崩溃恢复：先处理上次遗留的 pending 批次
      service.recoverPending();

      // 首次启动写入演示数据（原始清单不可变，之后不会重复）
      if (service.getState().actions.size === 0) {
        const outOfOrder = process.env.VAULT_SCENARIO === 'out-of-order';
        const crashAfterRaw = process.env.VAULT_SCENARIO === 'crash';
        for (const batch of buildSeedBatches({ outOfOrder })) {
          if (crashAfterRaw) {
            // 模拟“原始记录已落库、派生尚未完成”的崩溃现场
            const ord = service.repo.listBatches().length + 1;
            service.repo.insertBatch({
              batchId: batch.batchId,
              receivedAt: batch.receivedAt,
              rawJson: JSON.stringify(batch),
              ord,
            });
            for (const action of batch.actions) {
              service.repo.insertAction(action, batch.batchId, ord);
              for (const dep of action.deps) {
                service.repo.insertEdge(action.id, dep, batch.batchId);
              }
            }
            if (batch.batchId === 'b-002') break; // 崩溃在第 2 批之后
          } else {
            service.importBatch(batch);
          }
        }
        // 事后纠正 src/core.c 的错误摘要（只影响可达动作）
        service.addCorrection({ ...SEEDED_CORRECTION });
      }

      server.middlewares.use('/api', createApi(service) as never);
    },
  };
}

export default defineConfig({
  plugins: [react(), vaultPlugin()],
});


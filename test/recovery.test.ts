import { describe, expect, it } from "vitest";
import { closeDb, getDb, recover, setDbPath } from "../src/server/db.ts";
import { importManifest, listImports } from "../src/server/store.ts";
import { action, cleanupPath, manifest, tempFileDb } from "./helpers.ts";
import type { DatabaseSync } from "node:sqlite";

function openFresh(file: string): DatabaseSync {
  closeDb();
  setDbPath(file);
  return getDb();
}

describe("崩溃后恢复", () => {
  it("提交前模拟崩溃：导入停在 pending，重开连接后回滚并留痕，动作不可见", () => {
    const file = tempFileDb();
    try {
      openFresh(file);
      const res = importManifest(
        manifest("crash", [action({ id: "a" }), action({ id: "b", deps: ["a"] })]),
        { crashBeforeCommit: true },
      );
      expect(res.rolledBack).toBe(true);
      const pendingBefore = listImports().filter((i) => i.status === "pending");
      expect(pendingBefore).toHaveLength(1);

      // 模拟进程重启：新连接打开同一 WAL 数据库，getDb() 启动时自动恢复
      closeDb();
      const db2 = openFresh(file);
      const { rolledBack } = recover(db2);
      // 自动恢复已在打开连接时完成；pending 已清零
      expect(rolledBack).toEqual([]);
      const imports = listImports();
      const row = imports.find((i) => i.id === res.importId)!;
      expect(row.status).toBe("rolled_back");
      // 未提交批次的动作不可见
      expect(row.actionCount).toBe(0);
      const events = db2
        .prepare("SELECT event FROM recovery_events WHERE event = 'rollback-pending-import'")
        .all() as { event: string }[];
      expect(events.length).toBeGreaterThan(0);
    } finally {
      closeDb();
      cleanupPath(file);
    }
  });

  it("正常提交在重开后完好（WAL 持久性）", () => {
    const file = tempFileDb();
    try {
      openFresh(file);
      const res = importManifest(manifest("ok", [action({ id: "a" })]));
      expect(res.rolledBack).toBe(false);
      closeDb();
      openFresh(file);
      const row = listImports().find((i) => i.id === res.importId)!;
      expect(row.status).toBe("committed");
      expect(row.actionCount).toBe(1);
    } finally {
      closeDb();
      cleanupPath(file);
    }
  });
});

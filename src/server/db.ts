import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

export function openDb(filename: string): DB {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 导入批次：status=pending 表示原始记录已落库但派生未完成（崩溃恢复用）
  CREATE TABLE IF NOT EXISTS import_batches (
    batch_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    ord INTEGER NOT NULL
  );

  -- 原始动作清单：不可变，只插入不更新
  CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES import_batches(batch_id),
    raw_json TEXT NOT NULL,
    ord INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_edges (
    from_action TEXT NOT NULL REFERENCES actions(action_id),
    to_action TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    PRIMARY KEY (from_action, to_action)
  );

  -- 派生指纹：可随规则版本/纠正重算
  CREATE TABLE IF NOT EXISTS fingerprints (
    action_id TEXT PRIMARY KEY REFERENCES actions(action_id),
    key TEXT NOT NULL,
    components_json TEXT NOT NULL,
    dep_pins_json TEXT NOT NULL,
    status TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    output_hash TEXT NOT NULL,
    result_version TEXT NOT NULL,
    corrected_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_fp_key ON fingerprints(key);

  -- 观察到的缓存条目：绝不能最后写入覆盖（INSERT，不 UPDATE）
  CREATE TABLE IF NOT EXISTS cache_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL UNIQUE REFERENCES actions(action_id),
    key TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ce_key ON cache_entries(key);

  CREATE TABLE IF NOT EXISTS disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'open',
    resolution_note TEXT,
    first_seen TEXT NOT NULL
  );

  -- 争议双方（多方）来源与首次观察顺序，只追加
  CREATE TABLE IF NOT EXISTS dispute_parties (
    dispute_id INTEGER NOT NULL REFERENCES disputes(id),
    ord INTEGER NOT NULL,
    action_id TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (dispute_id, ord)
  );

  -- 输入摘要纠正：不改原始清单
  CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    old_algo TEXT NOT NULL,
    old_digest TEXT NOT NULL,
    new_algo TEXT NOT NULL,
    new_digest TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_corr_path ON corrections(path);

  -- 规范化规则版本：版本不可变
  CREATE TABLE IF NOT EXISTS rule_versions (
    version INTEGER PRIMARY KEY,
    spec_json TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rule_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_version INTEGER,
    to_version INTEGER NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  `);

  const existing = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!existing) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  }
}

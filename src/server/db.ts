// SQLite 存储层。
// 设计要点：
//  - raw_manifests/raw_actions 只追加、永不更新（原始清单不可变）；
//  - 导入逐行动作提交，pending 清单在崩溃重启后可恢复/补齐；
//  - 派生指纹按规则版本留痕；纠正以事件追加，重算生成新派生记录；
//  - 缓存条目绝不覆盖：同 key 异输出开争议，按首次观察顺序保留双方来源。

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename: string): DatabaseSync {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_manifests (
  manifest_id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  total_actions INTEGER NOT NULL,
  imported_actions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raw_actions (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id TEXT NOT NULL REFERENCES raw_manifests(manifest_id),
  action_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(manifest_id, seq),
  UNIQUE(manifest_id, action_id)
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  parent_version_id INTEGER,
  rules_json TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS rule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  result_version TEXT NOT NULL,
  components_json TEXT NOT NULL,
  pins_json TEXT NOT NULL,
  distrusted INTEGER NOT NULL DEFAULT 0,
  distrust_reason TEXT,
  computed_at TEXT NOT NULL,
  UNIQUE(action_id, manifest_id, rule_version_id)
);

CREATE TABLE IF NOT EXISTS cache_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  key TEXT NOT NULL,
  result_version TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_seq INTEGER NOT NULL UNIQUE,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  first_result_version TEXT NOT NULL,
  first_observed_seq INTEGER NOT NULL,
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_entries (
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  entry_id INTEGER NOT NULL REFERENCES cache_entries(id),
  ord INTEGER NOT NULL,
  PRIMARY KEY (dispute_id, entry_id)
);

CREATE TABLE IF NOT EXISTS digest_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  old_digest TEXT NOT NULL,
  new_digest TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distrust_marks (
  correction_id INTEGER NOT NULL REFERENCES digest_corrections(id),
  action_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  direct INTEGER NOT NULL,
  paths_json TEXT NOT NULL,
  PRIMARY KEY (correction_id, action_id, manifest_id)
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_key ON fingerprints(key);
CREATE INDEX IF NOT EXISTS idx_cache_key ON cache_entries(key);
`;

export interface StoredActionRow {
  manifestId: string;
  seq: number;
  payload: string;
}

/** 原子写入一个动作（崩溃恢复的最小事务单元） */
export function insertActionAtomically(db: DatabaseSync, row: StoredActionRow): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare(
      `INSERT INTO raw_actions (manifest_id, action_id, seq, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(manifest_id, seq) DO NOTHING`,
    );
    const action = JSON.parse(row.payload);
    stmt.run(row.manifestId, action.id, row.seq, row.payload);
    db.prepare(
      'UPDATE raw_manifests SET imported_actions = (SELECT COUNT(*) FROM raw_actions WHERE manifest_id = ?) WHERE manifest_id = ?',
    ).run(row.manifestId, row.manifestId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function beginManifest(db: DatabaseSync, manifestId: string, importedAt: string, total: number): void {
  db.prepare(
    `INSERT INTO raw_manifests (manifest_id, imported_at, pending, total_actions, imported_actions)
     VALUES (?, ?, 1, ?, 0)
     ON CONFLICT(manifest_id) DO NOTHING`,
  ).run(manifestId, importedAt, total);
}

export function completeManifest(db: DatabaseSync, manifestId: string): void {
  db.prepare('UPDATE raw_manifests SET pending = 0 WHERE manifest_id = ?').run(manifestId);
}

/** 崩溃后：返回仍处于 pending 的清单（演示/测试可用于验证恢复） */
export function pendingManifests(db: DatabaseSync): { manifestId: string; total: number; done: number }[] {
  const rows = db
    .prepare('SELECT manifest_id, total_actions, imported_actions FROM raw_manifests WHERE pending = 1')
    .all() as { manifest_id: string; total_actions: number; imported_actions: number }[];
  return rows.map((r) => ({ manifestId: r.manifest_id, total: r.total_actions, done: r.imported_actions }));
}

export function nextObservedSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(observed_seq), 0) + 1 AS seq FROM cache_entries').get() as {
    seq: number;
  };
  return row.seq;
}

export function lockId(): string {
  return randomUUID();
}

export function dbFileExists(path: string): boolean {
  return existsSync(path);
}

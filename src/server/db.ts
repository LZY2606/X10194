// SQLite 持久层：原始清单不可变（raw_json 原样保留），派生记录单独存放。
// 使用 WAL + 显式事务保证崩溃原子性；启动时回收未提交的导入。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

let instance: DatabaseSync | null = null;
let dbPath = ":memory:";

export function setDbPath(p: string): void {
  dbPath = p;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | committed | rolled_back
  imported_at INTEGER NOT NULL,
  committed_at INTEGER
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  action_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(import_id, action_id)
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,            -- approved | draft
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  restores_version_id INTEGER,
  superseded_by INTEGER
);

CREATE TABLE IF NOT EXISTS derivations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  import_id INTEGER NOT NULL REFERENCES imports(id),
  action_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  components_json TEXT NOT NULL,
  dep_pins_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  UNIQUE(rule_version_id, import_id, action_id)
);
CREATE INDEX IF NOT EXISTS idx_deriv_key ON derivations(rule_version_id, action_key);

CREATE TABLE IF NOT EXISTS cache_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_key TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL,
  result_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  action_id TEXT,
  import_id INTEGER,
  seq INTEGER NOT NULL UNIQUE,
  observed_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'   -- active | disputed
);
CREATE INDEX IF NOT EXISTS idx_entries_key ON cache_entries(rule_version_id, action_key);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_key TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL,
  first_entry_id INTEGER NOT NULL REFERENCES cache_entries(id),
  second_entry_id INTEGER NOT NULL REFERENCES cache_entries(id),
  first_source TEXT NOT NULL,
  second_source TEXT NOT NULL,
  first_result_hash TEXT NOT NULL,
  second_result_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  resolved_note TEXT
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  path TEXT NOT NULL,
  old_digest TEXT NOT NULL,
  new_digest TEXT NOT NULL,
  corrected_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS distrust (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  reason TEXT NOT NULL,
  root_actions TEXT NOT NULL,       -- JSON array
  correction_id INTEGER NOT NULL REFERENCES corrections(id),
  created_at INTEGER NOT NULL,
  UNIQUE(import_id, action_id, correction_id)
);

CREATE TABLE IF NOT EXISTS recovery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  instance = db;
  recover(db);
  seedBaselineRule(db);
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function resetDb(targetPath = ":memory:"): DatabaseSync {
  closeDb();
  dbPath = targetPath;
  if (targetPath !== ":memory:") {
    try {
      fs.rmSync(targetPath, { force: true });
      for (const suffix of ["-wal", "-shm"]) fs.rmSync(targetPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  return getDb();
}

function seedBaselineRule(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM rule_versions").get() as { n: number };
  if (row.n === 0) {
    db.prepare(
      `INSERT INTO rule_versions (id, spec_json, status, note, created_at)
       VALUES (?, ?, 'approved', ?, ?)`,
    ).run(
      1,
      JSON.stringify({
        normalizePathSeparators: false,
        pathAliases: [],
        argCommutativeFlags: [],
        symlinkPolicy: "link",
        ignoreMode: false,
        ignorePlatform: false,
      }),
      "基线规则：不归一任何未经声明的部分",
      Date.now(),
    );
  }
}

/** 崩溃恢复：回滚 pending 导入并留痕 */
export function recover(db: DatabaseSync): { rolledBack: number[] } {
  const pending = db
    .prepare("SELECT id, manifest_id FROM imports WHERE status = 'pending'")
    .all() as { id: number; manifest_id: string }[];
  if (pending.length === 0) return { rolledBack: [] };
  for (const p of pending) {
    db.prepare("UPDATE imports SET status = 'rolled_back' WHERE \"id\" = ?").run(p.id);
    db.prepare(
      "INSERT INTO recovery_events (event, detail, at) VALUES (?, ?, ?)",
    ).run("rollback-pending-import", `import ${p.id} manifest ${p.manifest_id}`, Date.now());
  }
  return { rolledBack: pending.map((p) => p.id) };
}

export function nextSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM cache_entries").get() as {
    s: number;
  };
  return row.s;
}

export function logEvent(db: DatabaseSync, event: string, detail: string): void {
  db.prepare("INSERT INTO recovery_events (event, detail, at) VALUES (?, ?, ?)").run(
    event,
    detail,
    Date.now(),
  );
}

import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS manifests (
      id TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      manifest_id TEXT NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (manifest_id, action_id)
    );
    CREATE TABLE IF NOT EXISTS rule_versions (
      version INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('draft','approved','rolledBack')),
      rules TEXT NOT NULL,
      description TEXT,
      base_version INTEGER,
      created_at TEXT NOT NULL,
      approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS action_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL,
      action_key TEXT NOT NULL,
      result_version TEXT NOT NULL,
      explanation TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      current INTEGER NOT NULL,
      trusted INTEGER NOT NULL,
      distrust_reasons TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(manifest_id, action_id, rule_version, generation)
    );
    CREATE INDEX IF NOT EXISTS idx_action_keys_key ON action_keys(action_key);
    CREATE INDEX IF NOT EXISTS idx_action_keys_current ON action_keys(manifest_id, action_id, current, trusted);
    CREATE TABLE IF NOT EXISTS input_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_id TEXT NOT NULL,
      input_id TEXT NOT NULL,
      old_digest TEXT NOT NULL,
      new_digest TEXT NOT NULL,
      corrected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_key TEXT NOT NULL,
      result_version TEXT NOT NULL,
      output_digest TEXT NOT NULL,
      outputs TEXT NOT NULL,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      observation_order INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('clean','disputed','superseded','invalidated'))
    );
    CREATE INDEX IF NOT EXISTS idx_cache_key ON cache_entries(action_key, state);
    CREATE TABLE IF NOT EXISTS disputes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_key TEXT NOT NULL,
      first_entry_id INTEGER NOT NULL REFERENCES cache_entries(id),
      conflicting_entry_id INTEGER NOT NULL REFERENCES cache_entries(id),
      first_output_digest TEXT NOT NULL,
      conflicting_output_digest TEXT NOT NULL,
      first_source TEXT NOT NULL,
      conflicting_source TEXT NOT NULL,
      first_observed_at TEXT NOT NULL,
      conflicting_observed_at TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );
  `);
  return db;
}

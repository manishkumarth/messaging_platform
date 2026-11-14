import fs from 'node:fs';
import path from 'node:path';
// Node's built-in SQLite driver: no native module to compile, so `npm install` is reproducible.
// Requires Node >= 22.13 (prints a one-line ExperimentalWarning on startup).
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrate.js';

export function openDatabase(file, { migrate = true } = {}) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (migrate) runMigrations(db);
  return db;
}

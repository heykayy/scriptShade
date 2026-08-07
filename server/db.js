// server/db.js
// Turso (libSQL) — a hosted, SQLite-compatible database with a real free tier.
// Unlike a local data.db file on Render's free web service (which has no
// attached disk and is wiped on every redeploy/restart), this data lives on
// Turso's own storage and survives redeploys, restarts, and free-tier sleep
// cycles indefinitely.

import { createClient } from "@libsql/client";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.warn(
    "WARNING: TURSO_DATABASE_URL is not set — falling back to a local file " +
    "(./db.sqlite). That's fine for local development, but on Render's free " +
    "tier this file will NOT persist across redeploys/restarts. Set " +
    "TURSO_DATABASE_URL + TURSO_AUTH_TOKEN for real persistence."
  );
}

const localDbPath = join(__dirname, "db.sqlite");
const localDbUrl = pathToFileURL(localDbPath).href; // e.g. file:///C:/Users/.../server/db.sqlite on Windows

export const client = createClient(
  url ? { url, authToken } : { url: localDbUrl }
);

// ── Thin async helpers so the rest of the app can stay close to the old
// better-sqlite3 .get()/.all()/.run() shape, just awaited. ────────────────
export async function dbGet(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rs.rows[0];
}

export async function dbAll(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rs.rows;
}

export async function dbRun(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return { lastInsertRowid: Number(rs.lastInsertRowid ?? 0), changes: rs.rowsAffected };
}

// Schema + safe migrations. Called once at startup before the server starts
// accepting requests (see index.js).
export async function initDb() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      recovery_code_hash TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0, -- vestigial: kept for schema stability, no longer read anywhere for auth
      created_at INTEGER NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS user_store (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Safe migrations for databases created before these columns existed.
  const cols = await dbAll("PRAGMA table_info(users)");
  if (!cols.some(c => c.name === "is_admin")) {
    await client.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some(c => c.name === "recovery_code_hash")) {
    await client.execute("ALTER TABLE users ADD COLUMN recovery_code_hash TEXT");
  }
}

export const EMPTY_STORE = JSON.stringify({
  topics: [], sessions: [], stats: {}, srs: {}, xp: 0, streak: { count: 0, lastDay: null },
});

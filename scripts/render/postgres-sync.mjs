#!/usr/bin/env node

/**
 * Render PostgreSQL Database Persistence Sync for OmniRoute.
 *
 * Solves the "redeploy clear data issue" on Render when running on ephemeral disk.
 * Connects to Render PostgreSQL via DATABASE_URL and persists storage.sqlite snapshots.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let pool = null;
let lastChecksum = null;

export function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.RENDER_POSTGRES_URL ||
    null
  );
}

export async function getPostgresPool() {
  if (pool) return pool;
  const dbUrl = getDatabaseUrl();
  if (!dbUrl) return null;

  try {
    const pg = await import("pg");
    const { Pool } = pg.default || pg;
    const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");

    pool = new Pool({
      connectionString: dbUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      max: 2, // Minimal connection pool for 512MB RAM constraint
      idleTimeoutMillis: 30000,
    });

    pool.on("error", (err) => {
      console.error("[Render Postgres] Unexpected pool error:", err.message);
    });

    return pool;
  } catch (err) {
    console.warn(
      `[Render Postgres] pg driver unavailable (${err.message}). Data persistence requires 'pg'.`
    );
    return null;
  }
}

export async function initStorageTable() {
  const p = await getPostgresPool();
  if (!p) return false;

  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS omniroute_storage (
        id VARCHAR(64) PRIMARY KEY,
        data BYTEA NOT NULL,
        size_bytes BIGINT NOT NULL,
        checksum VARCHAR(64),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    return true;
  } catch (err) {
    console.error("[Render Postgres] Failed to initialize storage table:", err.message);
    return false;
  }
}

export async function restoreDatabase(targetSqlitePath) {
  const dbUrl = getDatabaseUrl();
  if (!dbUrl) {
    console.log("[Render Postgres] DATABASE_URL not set; skipping database restore.");
    return { restored: false, reason: "no_db_url" };
  }

  const p = await getPostgresPool();
  if (!p) return { restored: false, reason: "no_pool" };

  await initStorageTable();

  // If local SQLite file exists and is non-empty, don't overwrite blindly unless force requested
  if (fs.existsSync(targetSqlitePath)) {
    const stat = fs.statSync(targetSqlitePath);
    if (stat.size > 0 && process.env.FORCE_RESTORE !== "true") {
      console.log(
        `[Render Postgres] Existing local database found (${stat.size} bytes). Preserving local data.`
      );
      try {
        const localBuf = fs.readFileSync(targetSqlitePath);
        lastChecksum = crypto.createHash("sha256").update(localBuf).digest("hex");
      } catch {}
      return { restored: false, reason: "local_exists" };
    }
  }

  try {
    const res = await p.query(
      `SELECT data, size_bytes, checksum, updated_at FROM omniroute_storage WHERE id = 'sqlite_primary'`
    );

    if (res.rows.length === 0 || !res.rows[0].data) {
      console.log("[Render Postgres] No prior snapshot found in PostgreSQL. Fresh database will be created.");
      return { restored: false, reason: "no_remote_data" };
    }

    const row = res.rows[0];
    const dataBuffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);

    // Ensure target directory exists
    const dir = path.dirname(targetSqlitePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Clean up any stale WAL/SHM sidecars from prior container instances
    for (const sidecar of [
      `${targetSqlitePath}-wal`,
      `${targetSqlitePath}-shm`,
      `${targetSqlitePath}-journal`,
    ]) {
      if (fs.existsSync(sidecar)) {
        try {
          fs.unlinkSync(sidecar);
        } catch {}
      }
    }

    fs.writeFileSync(targetSqlitePath, dataBuffer);
    lastChecksum = row.checksum || crypto.createHash("sha256").update(dataBuffer).digest("hex");

    console.log(
      `[Render Postgres] ✅ Successfully restored database (${dataBuffer.length} bytes, updated at ${row.updated_at}) from Render PostgreSQL! Data preserved across redeploy.`
    );
    return { restored: true, size: dataBuffer.length, updatedAt: row.updated_at };
  } catch (err) {
    console.error("[Render Postgres] Error restoring database from PostgreSQL:", err.message);
    return { restored: false, error: err.message };
  }
}

export async function saveDatabase(sourceSqlitePath) {
  const dbUrl = getDatabaseUrl();
  if (!dbUrl) return { saved: false, reason: "no_db_url" };

  if (!fs.existsSync(sourceSqlitePath)) {
    return { saved: false, reason: "file_missing" };
  }

  let buf;
  try {
    buf = fs.readFileSync(sourceSqlitePath);
  } catch (err) {
    return { saved: false, error: err.message };
  }

  if (buf.length === 0) {
    return { saved: false, reason: "empty_file" };
  }

  const checksum = crypto.createHash("sha256").update(buf).digest("hex");
  if (checksum === lastChecksum) {
    return { saved: false, reason: "unchanged" };
  }

  const p = await getPostgresPool();
  if (!p) return { saved: false, reason: "no_pool" };

  try {
    await p.query(
      `
      INSERT INTO omniroute_storage (id, data, size_bytes, checksum, updated_at)
      VALUES ('sqlite_primary', $1, $2, $3, NOW())
      ON CONFLICT (id) DO UPDATE SET
        data = EXCLUDED.data,
        size_bytes = EXCLUDED.size_bytes,
        checksum = EXCLUDED.checksum,
        updated_at = NOW();
      `,
      [buf, buf.length, checksum]
    );

    lastChecksum = checksum;
    console.log(
      `[Render Postgres] 💾 Synced database snapshot (${buf.length} bytes, sha256:${checksum.slice(0, 8)}) to Render PostgreSQL.`
    );
    return { saved: true, size: buf.length, checksum };
  } catch (err) {
    console.error("[Render Postgres] Failed to save database to PostgreSQL:", err.message);
    return { saved: false, error: err.message };
  }
}

export function startPeriodicSync(sqlitePath, intervalMs = 120_000) {
  const timer = setInterval(async () => {
    try {
      await saveDatabase(sqlitePath);
    } catch (err) {
      console.error("[Render Postgres] Periodic sync error:", err.message);
    }
  }, intervalMs);

  if (timer.unref) timer.unref();
  return timer;
}

export async function closePool() {
  if (pool) {
    try {
      await pool.end();
    } catch {}
    pool = null;
  }
}

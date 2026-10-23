#!/usr/bin/env node

/**
 * run-render.mjs — Main launcher for Render Hobby/Free Plan (512MB RAM).
 *
 * Coordinates:
 * 1. 512MB RAM memory tuning (NODE_OPTIONS --max-old-space-size=350 --optimize-for-size)
 * 2. Render PostgreSQL database restoration on boot (fixes redeploy clear data issue)
 * 3. Starting the standalone Next.js server on PORT (default 10000)
 * 4. Background PostgreSQL snapshot sync (every 2 minutes)
 * 5. Keep-alive worker to prevent sleeping (every 9 minutes)
 * 6. Graceful shutdown handler (SIGTERM/SIGINT) saving final snapshot before container exits
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { restoreDatabase, saveDatabase, startPeriodicSync, closePool } from "./postgres-sync.mjs";
import { startKeepAlive } from "./keep-alive.mjs";

const PORT = process.env.PORT || "10000";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, "storage.sqlite");
const MEMORY_MB = process.env.OMNIROUTE_MEMORY_MB || "350";

console.log("==================================================");
console.log("🚀 OmniRoute Render Cloud Runner Starting...");
console.log(`📊 Memory Budget: ${MEMORY_MB} MB (Target: Render 512MB compute)`);
console.log(`🌐 Port: ${PORT}`);
console.log(`📁 Data Path: ${SQLITE_FILE}`);
console.log("==================================================");

// 1. Enforce memory constraints for 512MB container
process.env.PORT = PORT;
process.env.OMNIROUTE_MEMORY_MB = MEMORY_MB;
const existingNodeOptions = process.env.NODE_OPTIONS || "";
if (!existingNodeOptions.includes("--max-old-space-size")) {
  process.env.NODE_OPTIONS = `${existingNodeOptions} --max-old-space-size=${MEMORY_MB} --optimize-for-size`.trim();
}

async function main() {
  // 2. Restore database from Render PostgreSQL before app boot
  console.log("[Render Init] Checking Render PostgreSQL for existing database backup...");
  try {
    await restoreDatabase(SQLITE_FILE);
  } catch (err) {
    console.error("[Render Init] Database restore check encountered error:", err.message);
  }

  // 3. Find server entry point
  let entryFile = "dev/run-standalone.mjs";
  if (!fs.existsSync(entryFile)) {
    if (fs.existsSync("server-ws.mjs")) entryFile = "server-ws.mjs";
    else if (fs.existsSync("server.js")) entryFile = "server.js";
    else if (fs.existsSync("scripts/dev/run-standalone.mjs")) entryFile = "scripts/dev/run-standalone.mjs";
  }

  console.log(`[Render Init] Spawning server entry: ${entryFile}`);

  const child = spawn(process.execPath, [entryFile], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT,
      HOSTNAME: "0.0.0.0",
      HOST: "0.0.0.0",
      DATA_DIR,
      OMNIROUTE_MEMORY_MB: MEMORY_MB,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      REQUIRE_API_KEY: process.env.REQUIRE_API_KEY || "false",
    },
  });

  // 4. Start Keep-Alive Worker
  startKeepAlive({ port: PORT });

  // 5. Start Background PostgreSQL Sync (every 2 minutes)
  const syncTimer = startPeriodicSync(SQLITE_FILE, 120_000);

  // 6. Graceful Shutdown & Final Snapshot Persistence
  let isShuttingDown = false;
  async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Render] Received ${signal}. Initiating graceful shutdown...`);

    // Terminate child server gracefully first so SQLite transactions close & WAL flushes
    child.kill(signal);

    try {
      // Wait briefly for child process to close database handles
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log("[Render] Saving final database snapshot to Render PostgreSQL...");
      await saveDatabase(SQLITE_FILE);
      await closePool();
      console.log("[Render] ✅ Final PostgreSQL snapshot complete. Safe to exit.");
    } catch (err) {
      console.error("[Render] Error during shutdown database sync:", err.message);
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));

  child.on("exit", (code, signal) => {
    console.log(`[Render] Child process exited with code=${code} signal=${signal}`);
    if (!isShuttingDown) {
      // If server exited unexpectedly, attempt to save snapshot and exit
      saveDatabase(SQLITE_FILE).finally(() => {
        process.exit(code ?? 1);
      });
    }
  });
}

main().catch((err) => {
  console.error("[Render Fatal] Startup failed:", err);
  process.exit(1);
});

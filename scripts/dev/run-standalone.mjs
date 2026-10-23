#!/usr/bin/env node

import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  resolveMaxOldSpaceMb,
  calibrateHeapFallbackMb,
  warnConflictingHeapLimits,
  buildStandaloneNodeOptions,
  spawnWithForwardedSignals,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";

const env = bootstrapEnv();
const runtimePorts = resolveRuntimePorts(env);
const childEnv = withRuntimePortEnv(env, runtimePorts);

// #2939 / #10353: OMNIROUTE_MEMORY_MB is the Docker/standalone heap knob.
// When it is set, we append --max-old-space-size last (V8 last-flag wins).
// When it is unset and NODE_OPTIONS already pins the heap, keep NODE_OPTIONS
// (#5238). Warn when both are set and the numbers disagree.
const maxOldSpaceMb = resolveMaxOldSpaceMb(
  childEnv.OMNIROUTE_MEMORY_MB,
  calibrateHeapFallbackMb(totalmem())
);
warnConflictingHeapLimits(childEnv, maxOldSpaceMb);
childEnv.NODE_OPTIONS = buildStandaloneNodeOptions(childEnv, maxOldSpaceMb);

// Prefer the WS-aware wrapper (server-ws.mjs) over the bare Next standalone
// server.js: it installs the trusted peer-IP stamp (scripts/dev/peer-stamp.mjs)
// that the authz middleware needs to allow loopback/LAN access to LOCAL_ONLY
// routes. Falling back to server.js fails CLOSED (every LOCAL_ONLY request 403s)
// rather than trusting the spoofable Host header.
const entry = existsSync("server-ws.mjs") ? "server-ws.mjs" : "server.js";

// Render Cloud PostgreSQL sync hook (fallback for standard Dockerfile)
if (childEnv.DATABASE_URL) {
  try {
    const syncModule = existsSync("scripts/render/postgres-sync.mjs")
      ? "../render/postgres-sync.mjs"
      : existsSync("../scripts/render/postgres-sync.mjs")
      ? "../../scripts/render/postgres-sync.mjs"
      : null;
    if (syncModule) {
      const { restoreDatabase, startPeriodicSync, saveDatabase, closePool } = await import(syncModule);
      const dataDir = childEnv.DATA_DIR || "/app/data";
      const sqlitePath = `${dataDir}/storage.sqlite`;
      await restoreDatabase(sqlitePath);
      startPeriodicSync(sqlitePath);
      process.on("SIGTERM", async () => {
        try {
          await saveDatabase(sqlitePath);
          await closePool();
        } catch {}
      });
    }
  } catch (err) {
    console.warn("[standalone] Optional postgres sync warning:", err.message);
  }
}

spawnWithForwardedSignals(process.execPath, [entry], {
  stdio: "inherit",
  env: childEnv,
});

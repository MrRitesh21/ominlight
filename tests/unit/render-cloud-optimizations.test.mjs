/**
 * Tests for Render cloud optimizations:
 * - 512MB RAM memory budget enforcement
 * - PostgreSQL persistence sync handlers
 * - Never-sleep keep-alive URL resolution
 * - Blueprint render.yaml integrity
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolvePingUrl } from "../../scripts/render/keep-alive.mjs";
import {
  getDatabaseUrl,
  restoreDatabase,
  saveDatabase,
} from "../../scripts/render/postgres-sync.mjs";

test("Render Keep-Alive: resolvePingUrl defaults to local health endpoint", () => {
  const origEnv = { ...process.env };
  delete process.env.KEEP_ALIVE_URL;
  delete process.env.RENDER_EXTERNAL_URL;

  const url = resolvePingUrl(10000);
  assert.equal(url, "http://127.0.0.1:10000/api/health");

  process.env.RENDER_EXTERNAL_URL = "https://omniroute.onrender.com";
  assert.equal(resolvePingUrl(10000), "https://omniroute.onrender.com/api/health");

  process.env.KEEP_ALIVE_URL = "https://custom-domain.com/health";
  assert.equal(resolvePingUrl(10000), "https://custom-domain.com/health");

  process.env = origEnv;
});

test("Render Postgres Sync: getDatabaseUrl extracts connection strings", () => {
  const origEnv = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.RENDER_POSTGRES_URL;

  assert.equal(getDatabaseUrl(), null);

  process.env.RENDER_POSTGRES_URL = "postgres://user:pass@render-db:5432/db";
  assert.equal(getDatabaseUrl(), "postgres://user:pass@render-db:5432/db");

  process.env.DATABASE_URL = "postgres://user:pass@live-db:5432/omniroute";
  assert.equal(getDatabaseUrl(), "postgres://user:pass@live-db:5432/omniroute");

  process.env = origEnv;
});

test("Render Postgres Sync: restoreDatabase gracefully skips when DATABASE_URL is unset", async () => {
  const origEnv = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.RENDER_POSTGRES_URL;

  const result = await restoreDatabase("/tmp/nonexistent.sqlite");
  assert.equal(result.restored, false);
  assert.equal(result.reason, "no_db_url");

  process.env = origEnv;
});

test("Render Postgres Sync: saveDatabase handles non-existent file gracefully", async () => {
  const origEnv = { ...process.env };
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";

  const result = await saveDatabase("/tmp/definitely-missing-file-12345.sqlite");
  assert.equal(result.saved, false);
  assert.equal(result.reason, "file_missing");

  process.env = origEnv;
});

test("Render Blueprint: render.yaml exists and defines web service + postgres db", () => {
  assert.ok(fs.existsSync("render.yaml"), "render.yaml must exist");
  const content = fs.readFileSync("render.yaml", "utf8");

  assert.match(content, /type:\s*web/);
  assert.match(content, /dockerfilePath:\s*\.\/Dockerfile\.render/);
  assert.match(content, /OMNIROUTE_MEMORY_MB/);
  assert.match(content, /350/);
  assert.match(content, /--max-old-space-size=350/);
  assert.match(content, /KEEP_ALIVE/);
  assert.match(content, /omniroute-postgres/);
  assert.match(content, /DATABASE_URL/);
});

test("Render Dockerfile: Dockerfile.render configures 512MB RAM and entrypoint", () => {
  assert.ok(fs.existsSync("Dockerfile.render"), "Dockerfile.render must exist");
  const content = fs.readFileSync("Dockerfile.render", "utf8");

  assert.match(content, /OMNIROUTE_MEMORY_MB=350/);
  assert.match(content, /--max-old-space-size=350/);
  assert.match(content, /PORT=10000/);
  assert.match(content, /scripts\/render\/run-render\.mjs/);
});

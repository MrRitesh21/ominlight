#!/usr/bin/env node

/**
 * Render Keep-Alive Worker for OmniRoute.
 *
 * Keeps Render free/hobby services awake by sending periodic heartbeat pings
 * to prevent the instance from sleeping after 15 minutes of inactivity.
 */

export function resolvePingUrl(port = 10000) {
  if (process.env.KEEP_ALIVE_URL) {
    return process.env.KEEP_ALIVE_URL;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    const base = process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
    return `${base}/api/health`;
  }
  return `http://127.0.0.1:${port}/api/health`;
}

export function startKeepAlive(options = {}) {
  if (process.env.KEEP_ALIVE === "false") {
    console.log("[Render Keep-Alive] Disabled by KEEP_ALIVE=false.");
    return null;
  }

  const port = options.port || process.env.PORT || 10000;
  const intervalMs = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 9 * 60 * 1000; // 9 minutes (Render sleeps at 15m)
  const pingUrl = resolvePingUrl(port);

  console.log(`[Render Keep-Alive] Activated! Pinging ${pingUrl} every ${Math.round(intervalMs / 60000)} minutes.`);

  // Delay first ping by 1 minute to allow server startup
  const initialTimer = setTimeout(() => {
    ping();
  }, 60_000);
  if (initialTimer.unref) initialTimer.unref();

  async function ping() {
    try {
      const url = resolvePingUrl(port);
      const res = await fetch(url, {
        headers: { "User-Agent": "OmniRoute-KeepAlive/1.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        console.log(`[Render Keep-Alive] 💓 Ping OK (${res.status}) at ${new Date().toISOString()}`);
      } else {
        console.warn(`[Render Keep-Alive] ⚠️ Ping returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[Render Keep-Alive] Ping probe warning: ${err.message}`);
    }
  }

  const intervalTimer = setInterval(ping, intervalMs);
  if (intervalTimer.unref) intervalTimer.unref();

  return {
    stop() {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
    pingNow: ping,
  };
}

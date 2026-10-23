# OmniRoute Render Cloud Deployment Guide

This directory contains the production-grade optimizations and deployment tooling for running **OmniRoute** on the **Render Free / Hobby Plan (512MB RAM Compute + Render PostgreSQL)**.

---

## 🛠️ The 3 Core Optimizations

### 1. 512MB RAM Compute Optimization (No OOM Crashes)
Render's Free and Hobby plans provide **512 MB RAM**. Running Node.js and Next.js without constraints frequently triggers cgroup memory limits (`OOMKilled`, exit code 137).

- **V8 Heap Clamped**: `OMNIROUTE_MEMORY_MB=350` and `NODE_OPTIONS="--max-old-space-size=350 --optimize-for-size"` restrict heap allocation to 350MB, reserving ~162MB for native C++ bindings (`better-sqlite3`), buffers, and OS overhead.
- **Aggressive Garbage Collection**: `--optimize-for-size` instructs V8 to optimize for smaller memory footprint and trigger garbage collection cycles sooner.
- **SQLite Page Cache Tuning**: Automatically reduces SQLite's memory cache from 64MB down to 8MB (`8192 KiB`) when running under 512MB environments, freeing an additional 56MB of RAM.
- **Single Build Worker**: `OMNIROUTE_BUILD_WORKERS=1` prevents Next.js page collection from exhausting memory during Docker builds.

### 2. Never Sleep (Keep-Alive Heartbeat)
Render free web services spin down and sleep after 15 minutes of HTTP inactivity.

- **Background Heartbeat Worker** (`scripts/render/keep-alive.mjs`):
  - Every 9 minutes (configurable via `KEEP_ALIVE_INTERVAL_MS`), sends a lightweight HTTP GET request to `/api/health`.
  - Automatically discovers `RENDER_EXTERNAL_URL` (e.g. `https://omniroute.onrender.com`).
  - Keeps the service warm 24/7 with zero downtime and minimal CPU usage.

### 3. Redeploy Clear Data Fix (Render PostgreSQL Persistence)
Render containers run on **ephemeral disk storage**. Whenever Render redeploys or restarts a container, local disk storage (`/app/data/storage.sqlite`) is wiped.

- **Automated PostgreSQL Snapshot Sync** (`scripts/render/postgres-sync.mjs`):
  - **On Startup (Pre-Boot)**: Before SQLite initializes, checks Render PostgreSQL (`omniroute_storage` table). If a snapshot exists, downloads and restores `storage.sqlite` into `/app/data/storage.sqlite`. All provider keys, combos, configs, and history survive redeployment!
  - **Periodic Sync**: Automatically captures an incremental SHA-256 snapshot every 2 minutes while running.
  - **Graceful Shutdown Trap**: Intercepts Render's `SIGTERM` signal (sent 30 seconds before container replacement during redeploy), checkpoints SQLite, uploads the final database snapshot to PostgreSQL, and exits cleanly.

---

## 🚀 Deployment Methods

### Option 1: Automatic Deployment with Render API Key
Once you obtain your Render API key:

```bash
node scripts/render/deploy-to-render.mjs --key=rnd_xxxxxxxxxxxxxxxxxxxx
```

Or pass your repository URL:
```bash
node scripts/render/deploy-to-render.mjs --key=rnd_xxxxxxxxxxxxxxxxxxxx --repo=https://github.com/your-username/OmniRoute
```

The script will automatically:
1. Authenticate with your Render account.
2. Provision a free **Render PostgreSQL Database** (`omniroute-postgres`).
3. Configure and deploy the **OmniRoute Web Service** with all 512MB RAM, Never-Sleep, and PostgreSQL persistence settings.

---

### Option 2: Render Blueprint (1-Click Deploy via `render.yaml`)
1. Push this repository to your GitHub.
2. Go to the [Render Dashboard](https://dashboard.render.com).
3. Click **New +** -> **Blueprint**.
4. Select your OmniRoute repository.
5. Render will detect `render.yaml` and automatically provision both the **Web Service** and the **PostgreSQL Database** pre-connected!

---

### Option 3: Manual Render Dashboard Setup
If setting up manually in the Render Dashboard:

1. **Create PostgreSQL Database**:
   - Name: `omniroute-postgres`
   - Plan: Free (or Starter)
   - Database: `omniroute`
   - User: `omniroute`

2. **Create Web Service**:
   - Environment: `Docker`
   - Dockerfile Path: `./Dockerfile.render`
   - Plan: Free (512MB RAM) or Starter (Hobby)
   - Health Check Path: `/api/health`

3. **Add Environment Variables**:
   | Key | Value | Purpose |
   |---|---|---|
   | `PORT` | `10000` | Render default port |
   | `OMNIROUTE_MEMORY_MB` | `350` | 512MB RAM limit protection |
   | `NODE_OPTIONS` | `--max-old-space-size=350 --optimize-for-size` | Heap optimization |
   | `KEEP_ALIVE` | `true` | Prevents service sleep |
   | `REQUIRE_API_KEY` | `false` | Access control (set to true if needed) |
   | `DATA_DIR` | `/app/data` | Ephemeral storage directory |
   | `DATABASE_URL` | *Linked from omniroute-postgres* | Persistent PostgreSQL backing store |

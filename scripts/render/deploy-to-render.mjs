#!/usr/bin/env node

/**
 * Render Deployment CLI Tool for OmniRoute.
 *
 * Automates provisioning and deploying OmniRoute to Render:
 * - Creates/Configures Render PostgreSQL Database
 * - Configures 512MB RAM compute environment & never-sleep keep-alive
 * - Connects Web Service with PostgreSQL
 * - Triggers zero-downtime deployment
 *
 * Usage:
 *   node scripts/render/deploy-to-render.mjs --key=rnd_xxxxxxxxxxxx
 *   or:
 *   RENDER_API_KEY=rnd_xxxxxxxxxxxx node scripts/render/deploy-to-render.mjs
 */

const RENDER_API_BASE = "https://api.render.com/v1";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    apiKey: process.env.RENDER_API_KEY || null,
    repo: process.env.RENDER_GIT_REPO || null,
    branch: process.env.RENDER_GIT_BRANCH || "main",
    region: process.env.RENDER_REGION || "oregon",
    plan: process.env.RENDER_PLAN || "free",
    databaseUrl: process.env.DATABASE_URL || null,
    serviceName: process.env.RENDER_SERVICE_NAME || "omniroute",
  };

  for (const arg of args) {
    if (arg.startsWith("--key=")) {
      options.apiKey = arg.split("=")[1].trim();
    } else if (arg.startsWith("--repo=")) {
      options.repo = arg.split("=")[1].trim();
    } else if (arg.startsWith("--branch=")) {
      options.branch = arg.split("=")[1].trim();
    } else if (arg.startsWith("--region=")) {
      options.region = arg.split("=")[1].trim();
    } else if (arg.startsWith("--plan=")) {
      options.plan = arg.split("=")[1].trim();
    } else if (arg.startsWith("--db=") || arg.startsWith("--database-url=")) {
      options.databaseUrl = arg.split("=")[1].trim();
    } else if (arg.startsWith("--name=")) {
      options.serviceName = arg.split("=")[1].trim();
    }
  }

  return options;
}

async function renderFetch(endpoint, apiKey, options = {}) {
  const url = `${RENDER_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = typeof data === "object" && data.message ? data.message : text;
    throw new Error(`Render API Error (${res.status} ${res.statusText}): ${msg}`);
  }

  return data;
}

async function getOwners(apiKey) {
  const list = await renderFetch("/owners?limit=20", apiKey);
  return list.map((item) => item.owner);
}

async function getServices(apiKey) {
  return await renderFetch("/services?limit=50", apiKey);
}

async function getPostgresInstances(apiKey) {
  return await renderFetch("/postgres?limit=20", apiKey);
}

async function createPostgres(apiKey, ownerId, region, plan) {
  console.log(`[Render Deploy] Creating Render PostgreSQL instance 'omniroute-postgres' (${plan} plan)...`);
  const payload = {
    name: "omniroute-postgres",
    ownerId,
    plan,
    databaseName: "omniroute",
    databaseUser: "omniroute",
    region,
  };

  const created = await renderFetch("/postgres", apiKey, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return created;
}

async function createWebService(apiKey, ownerId, options, databaseUrl) {
  console.log(`[Render Deploy] Creating OmniRoute Web Service on Render (${options.plan} plan, 512MB RAM)...`);
  
  const envVars = [
    { key: "PORT", value: "10000" },
    { key: "OMNIROUTE_MEMORY_MB", value: "350" },
    { key: "NODE_OPTIONS", value: "--max-old-space-size=350 --optimize-for-size" },
    { key: "KEEP_ALIVE", value: "true" },
    { key: "REQUIRE_API_KEY", value: "false" },
    { key: "DATA_DIR", value: "/app/data" },
  ];

  if (databaseUrl) {
    envVars.push({ key: "DATABASE_URL", value: databaseUrl });
  }

  const payload = {
    type: "web_service",
    name: "omniroute",
    ownerId,
    repo: options.repo,
    branch: options.branch,
    autoDeploy: "yes",
    serviceDetails: {
      env: "docker",
      dockerfilePath: "./Dockerfile.render",
      plan: options.plan,
      region: options.region,
      healthCheckPath: "/api/health",
      envVars,
    },
  };

  const service = await renderFetch("/services", apiKey, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return service;
}

async function triggerDeploy(apiKey, serviceId) {
  console.log(`[Render Deploy] Triggering deployment for service ID: ${serviceId}...`);
  return await renderFetch(`/services/${serviceId}/deploys`, apiKey, {
    method: "POST",
    body: JSON.stringify({ clearCache: "do_not_clear" }),
  });
}

async function main() {
  const options = parseArgs();

  if (!options.apiKey) {
    console.error("❌ Render API Key is required!");
    console.error("\nPlease provide your Render API key via:");
    console.error("  node scripts/render/deploy-to-render.mjs --key=rnd_xxxxxxxxxxxx");
    console.error("or set RENDER_API_KEY in your environment.\n");
    console.error("To get your Render API key:");
    console.error("  1. Log in to https://dashboard.render.com");
    console.error("  2. Go to Account Settings -> API Keys");
    console.error("  3. Create a new API key and copy it.");
    process.exit(1);
  }

  console.log("==================================================");
  console.log("🚀 OmniRoute Render Automatic Deployer");
  console.log("==================================================");

  // 1. Verify API Key and Owner
  console.log("[Render Deploy] Validating Render API Key...");
  let owners;
  try {
    owners = await getOwners(options.apiKey);
  } catch (err) {
    console.error("❌ Failed to authenticate with Render API:", err.message);
    process.exit(1);
  }

  if (owners.length === 0) {
    console.error("❌ No Render account owners found for this API key.");
    process.exit(1);
  }

  const owner = owners[0];
  console.log(`✅ Authenticated as: ${owner.name} (${owner.email || owner.type}, ID: ${owner.id})`);

  // 2. Check or Create Render PostgreSQL
  let dbConnectionString = options.databaseUrl;

  if (!dbConnectionString) {
    console.log("[Render Deploy] Checking existing PostgreSQL instances...");
    const rawDbs = await getPostgresInstances(options.apiKey);
    const dbs = rawDbs.map((d) => d.postgres || d);
    let targetDb = dbs.find(
      (d) => d.name === "omniroute-postgres" || (d.name && d.name.includes("omniroute"))
    );

    if (!targetDb) {
      console.log("[Render Deploy] No omniroute-postgres found. Creating new PostgreSQL database...");
      targetDb = await createPostgres(options.apiKey, owner.id, options.region, options.plan);
      console.log(`✅ Created PostgreSQL instance: ${targetDb.name} (ID: ${targetDb.id})`);
    } else {
      console.log(`✅ Found existing PostgreSQL instance: ${targetDb.name} (ID: ${targetDb.id})`);
    }

    // Retrieve connection details
    try {
      const fullDb = await renderFetch(`/postgres/${targetDb.id}`, options.apiKey);
      dbConnectionString =
        fullDb.connectionInfo?.internalConnectionString ||
        fullDb.connectionInfo?.externalConnectionString;
    } catch (err) {
      console.warn(`[Render Deploy] Could not fetch connection string directly: ${err.message}`);
    }
  } else {
    console.log(
      `✅ Using provided PostgreSQL database: ${dbConnectionString.replace(/:[^:@]+@/, ":***@")}`
    );
  }

  // 3. Check or Create Web Service
  console.log("[Render Deploy] Checking existing Web Services...");
  const rawServices = await getServices(options.apiKey);
  const services = rawServices.map((s) => s.service || s);
  let webService = services.find(
    (s) => s.name === options.serviceName || s.slug === options.serviceName
  );

  if (!webService) {
    if (!options.repo) {
      console.log("\nℹ️ To automatically create the Web Service via API, provide your GitHub/Git repository URL:");
      console.log(
        "  node scripts/render/deploy-to-render.mjs --key=" +
          options.apiKey +
          " --db=\"" +
          options.databaseUrl +
          "\" --repo=https://github.com/your-username/OmniRoute\n"
      );
      console.log("OR deploy instantly using Render Blueprint (render.yaml):");
      console.log("  1. Push this code to your GitHub repo");
      console.log("  2. In Render Dashboard, click 'New +' -> 'Blueprint'");
      console.log("  3. Select your repository and click 'Apply'!\n");
      return;
    }

    webService = await createWebService(options.apiKey, owner.id, options, dbConnectionString);
    console.log(`✅ Created Web Service: ${webService.name} (ID: ${webService.id})`);
  } else {
    console.log(`✅ Found existing Web Service: ${webService.name} (ID: ${webService.id})`);
    const deploy = await triggerDeploy(options.apiKey, webService.id);
    console.log(`🚀 Deployment triggered! Deploy ID: ${deploy.id}`);
  }

  console.log("\n==================================================");
  console.log("🎉 Render Deployment Setup Complete!");
  console.log("==================================================");
  console.log("Status: Optimized for 512MB RAM Compute");
  console.log("Storage: Persistent via Render PostgreSQL (no redeploy data loss)");
  console.log("Keep-Alive: Enabled (Never Sleep)");
  if (webService?.service?.serviceDetails?.url) {
    console.log(`App URL: ${webService.service.serviceDetails.url}`);
  }
}

main().catch((err) => {
  console.error("❌ Fatal Error:", err);
  process.exit(1);
});

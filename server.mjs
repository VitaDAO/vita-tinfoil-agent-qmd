/**
 * VITA QMD Service — Tinfoil TEE version
 *
 * Port of qmd-gpu/server.mjs for running inside a Tinfoil enclave.
 * Differences from Prime Intellect version:
 *   - HTTP (not HTTPS) — Tinfoil shim handles TLS termination
 *   - Data stored on ramdisk (ephemeral — persisted to Supabase externally)
 *   - No TLS certs needed
 *
 * Endpoints:
 *   POST   /ingest              — Upload user workspace files for indexing
 *   POST   /predict             — Search user's indexed workspace
 *   GET    /workspace/:user_id  — Return all stored workspace files for a user
 *   POST   /consolidate/:user_id — Run LLM memory consolidation for a user
 *   DELETE /user                — Delete all data for a user (GDPR)
 *   GET    /health              — Readiness/liveness check
 */

import { createServer } from "node:http";
import { createStore } from "@tobilu/qmd";
import {
  mkdirSync, writeFileSync, existsSync, rmSync,
  readdirSync, statSync, readFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const PORT = parseInt(process.env.PORT || "8000", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const INACTIVITY_MINUTES = parseInt(process.env.INACTIVITY_MINUTES || "15", 10);
const API_SECRET = process.env.QMD_API_SECRET || "";

// ── Per-user QMD store cache ─────────────────────────────────────────────
const stores = new Map();
let modelsReady = false;

async function getOrCreateStore(userId) {
  if (stores.has(userId)) {
    return stores.get(userId);
  }

  const userDir = join(DATA_DIR, userId, "workspace");
  const dbPath = join(DATA_DIR, userId, "index.sqlite");

  mkdirSync(userDir, { recursive: true });

  const store = await createStore({
    dbPath,
    config: {
      collections: {
        memory: { path: userDir, pattern: "{MEMORY.md,memory/*.md}" },
      },
    },
  });

  stores.set(userId, store);
  return store;
}

// ── Per-user locking ─────────────────────────────────────────────────────
const userLocks = new Map();

async function withUserLock(userId, fn) {
  const prev = userLocks.get(userId) || Promise.resolve();
  const current = prev.then(fn, fn);
  userLocks.set(userId, current.catch(() => {}));
  return current;
}

// ── Per-user activity tracking ───────────────────────────────────────────
const lastActive = new Map();

function touchUser(userId) {
  lastActive.set(userId, Date.now());
}

function isUserActive(userId) {
  const last = lastActive.get(userId);
  if (!last) return false;
  return (Date.now() - last) < INACTIVITY_MINUTES * 60 * 1000;
}

// ── Consolidation state ──────────────────────────────────────────────────
const consolidationMeta = new Map();

function getConsolidationMeta(userId) {
  if (!consolidationMeta.has(userId)) {
    const metaPath = join(DATA_DIR, userId, "consolidation.json");
    if (existsSync(metaPath)) {
      try {
        consolidationMeta.set(userId, JSON.parse(readFileSync(metaPath, "utf-8")));
      } catch {
        consolidationMeta.set(userId, { version: 0, consolidatedHashes: [] });
      }
    } else {
      consolidationMeta.set(userId, { version: 0, consolidatedHashes: [] });
    }
  }
  return consolidationMeta.get(userId);
}

function saveConsolidationMeta(userId, meta) {
  consolidationMeta.set(userId, meta);
  const metaPath = join(DATA_DIR, userId, "consolidation.json");
  mkdirSync(join(DATA_DIR, userId), { recursive: true });
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Handlers ─────────────────────────────────────────────────────────────

async function handleIngest(req, res) {
  const startTime = Date.now();
  const body = await readBody(req);
  const { user_id, files } = body;

  const safeUserId = sanitizeUserId(user_id);
  if (!safeUserId || !files || !Array.isArray(files)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "valid user_id and files[] required" }));
    return;
  }

  await withUserLock(user_id, async () => {
    touchUser(user_id);

    const userDir = join(DATA_DIR, user_id, "workspace");
    mkdirSync(userDir, { recursive: true });

    for (const file of files) {
      if (!file.name || !file.content) continue;
      if (file.name.includes("..") || file.name.startsWith("/")) continue;
      const filePath = join(userDir, file.name);
      if (!filePath.startsWith(userDir)) continue;
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }

    const store = await getOrCreateStore(user_id);
    await store.update({ collections: ["memory"] });
    await store.embed();
  });

  const elapsed = Date.now() - startTime;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, files: files.length, elapsed }));
}

async function handleSearch(req, res) {
  const startTime = Date.now();
  const body = await readBody(req);
  const { user_id, query, limit = 5 } = body;

  if (!user_id || !query) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "user_id and query required" }));
    return;
  }

  const userDir = join(DATA_DIR, user_id, "workspace");
  if (!existsSync(userDir)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [] }));
    return;
  }

  let results = [];
  await withUserLock(user_id, async () => {
    touchUser(user_id);
    const store = await getOrCreateStore(user_id);
    try {
      results = await store.search({
        queries: [
          { type: "lex", query },
          { type: "vec", query },
        ],
        collection: "memory",
        limit,
        rerank: true,
      }) || [];
    } catch (err) {
      console.error(`[SEARCH] Search failed: ${err}`);
      results = [];
    }
  });

  const elapsed = Date.now() - startTime;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ results, elapsed }));
}

async function handleGetWorkspace(req, res, userId) {
  const userDir = join(DATA_DIR, userId, "workspace");

  if (!existsSync(userDir)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: [] }));
    return;
  }

  const files = [];
  function walkDir(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkDir(full);
      } else if (entry.endsWith(".md")) {
        const relPath = relative(userDir, full);
        files.push({
          name: relPath,
          content: readFileSync(full, "utf-8"),
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    }
  }
  walkDir(userDir);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ user_id: userId, files, count: files.length }));
}

async function handleConsolidate(req, res, userId) {
  if (isUserActive(userId)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "User is active, consolidation postponed",
      retryAfter: INACTIVITY_MINUTES * 60,
    }));
    return;
  }

  let result;
  await withUserLock(userId, async () => {
    result = await runConsolidation(userId);
  });

  res.writeHead(result.error ? 500 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

async function runConsolidation(userId) {
  const startTime = Date.now();
  const userDir = join(DATA_DIR, userId, "workspace");
  const memoryDir = join(userDir, "memory");

  if (!existsSync(memoryDir)) {
    return { ok: true, skipped: true, reason: "No daily logs found" };
  }

  const dailyLogs = [];
  for (const name of readdirSync(memoryDir)) {
    if (!name.endsWith(".md")) continue;
    const content = readFileSync(join(memoryDir, name), "utf-8");
    const hash = hashContent(content);
    dailyLogs.push({ name, content, hash, path: join(memoryDir, name) });
  }

  if (dailyLogs.length === 0) {
    return { ok: true, skipped: true, reason: "No daily logs to consolidate" };
  }

  const meta = getConsolidationMeta(userId);
  const newLogs = dailyLogs.filter(l => !meta.consolidatedHashes.includes(l.hash));

  if (newLogs.length === 0) {
    return { ok: true, skipped: true, reason: "All logs already consolidated" };
  }

  const memoryPath = join(userDir, "MEMORY.md");
  const existingMemory = existsSync(memoryPath)
    ? readFileSync(memoryPath, "utf-8")
    : "";

  const logsText = newLogs
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(l => `### ${l.name}\n${l.content}`)
    .join("\n\n");

  const prompt = buildConsolidationPrompt(existingMemory, logsText);

  const store = await getOrCreateStore(userId);
  let consolidatedMemory;

  try {
    consolidatedMemory = await store.generate({
      prompt,
      maxTokens: 4096,
    });
  } catch (err) {
    console.error(`[CONSOLIDATE] LLM generation failed for ${userId}: ${err.message}`);
    console.error("[CONSOLIDATE] Falling back to append-based consolidation");
    consolidatedMemory = fallbackConsolidation(existingMemory, newLogs);
  }

  writeFileSync(memoryPath, consolidatedMemory, "utf-8");

  const newVersion = meta.version + 1;
  const allHashes = [...meta.consolidatedHashes, ...newLogs.map(l => l.hash)];
  saveConsolidationMeta(userId, {
    version: newVersion,
    consolidatedHashes: allHashes,
    lastConsolidated: new Date().toISOString(),
    logsConsumed: newLogs.map(l => l.name),
  });

  for (const log of newLogs) {
    try { rmSync(log.path); } catch (err) {
      console.error(`[CONSOLIDATE] Failed to delete ${log.path}: ${err.message}`);
    }
  }

  await store.update({ collections: ["memory"] });
  await store.embed();

  const elapsed = Date.now() - startTime;
  return { ok: true, version: newVersion, logsConsumed: newLogs.length, elapsed };
}

function buildConsolidationPrompt(existingMemory, logsText) {
  return `You are a memory consolidation system for a personal AI health assistant. Your job is to maintain a three-layer memory file.

## Current MEMORY.md
${existingMemory || "(empty — first consolidation)"}

## New Daily Logs to Consolidate
${logsText}

## Instructions
Update the MEMORY.md with the following three-layer structure. Output ONLY the updated markdown, nothing else.

### Rules:
- **Short-Term**: Keep only the last 2-3 sessions worth of context. Replace older short-term entries.
- **Long-Term**: Extract and maintain curated facts about the user. UPDATE existing facts if new info contradicts them. Do NOT just append — keep this section bounded (max 20 items).
- **Episodic**: Add a brief 1-2 sentence summary for each new session. Keep the last 30 episodes max, removing the oldest.

Output the updated MEMORY.md now:

# Memory

## Short-Term
(Recent session context — last 2-3 interactions)

## Long-Term
(Curated facts about this user — bounded, updated not appended)

## Episodic
(Compressed session summaries — most recent first)`;
}

function fallbackConsolidation(existingMemory, newLogs) {
  let md = existingMemory || "# Memory\n\n## Short-Term\n\n## Long-Term\n\n## Episodic\n";
  const today = new Date().toISOString().split("T")[0];
  md += `\n\n## Session Log — ${today}\n\n`;
  for (const log of newLogs) {
    md += `### ${log.name}\n${log.content.slice(0, 500)}\n\n`;
  }
  return md;
}

async function handleDelete(req, res) {
  const body = await readBody(req);
  const { user_id } = body;

  if (!user_id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "user_id required" }));
    return;
  }

  await withUserLock(user_id, async () => {
    stores.delete(user_id);
    consolidationMeta.delete(user_id);
    lastActive.delete(user_id);

    const userPath = join(DATA_DIR, user_id);
    if (existsSync(userPath)) {
      rmSync(userPath, { recursive: true, force: true });
    }
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, deleted: user_id }));
}

async function handleHealth(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    modelsReady,
    uptime: process.uptime(),
    activeUsers: lastActive.size,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB limit

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sanitizeUserId(userId) {
  if (!userId || typeof userId !== "string") return null;
  // Only allow UUID-like characters
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) return null;
  if (userId.includes("..") || userId.includes("/")) return null;
  return userId;
}

function parseUrlPath(url) {
  const parts = (url || "").split("?")[0].split("/").filter(Boolean);
  return { base: "/" + (parts[0] || ""), param: parts[1] || "" };
}

// ── Server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const { base, param } = parseUrlPath(req.url);

    if (req.method === "GET" && req.url === "/health") {
      return handleHealth(req, res);
    }

    // Auth check — all endpoints except /health require shared secret
    if (API_SECRET && req.headers["x-api-secret"] !== API_SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.method === "POST" && req.url === "/predict") {
      return handleSearch(req, res);
    }
    if (req.method === "POST" && req.url === "/ingest") {
      return handleIngest(req, res);
    }
    if (req.method === "GET" && base === "/workspace" && param) {
      return handleGetWorkspace(req, res, param);
    }
    if (req.method === "POST" && base === "/consolidate" && param) {
      return handleConsolidate(req, res, param);
    }
    if (req.method === "DELETE" && req.url === "/user") {
      return handleDelete(req, res);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("Request error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

mkdirSync(DATA_DIR, { recursive: true });

server.listen(PORT, async () => {
  console.log(`QMD service listening on port ${PORT} (HTTP)`);
  console.log(`Data directory: ${DATA_DIR}`);

  // Pre-load all models at startup
  try {
    console.log("Pre-loading QMD models...");
    const warmupDir = join(DATA_DIR, "_warmup", "workspace");
    mkdirSync(warmupDir, { recursive: true });
    writeFileSync(join(warmupDir, "warmup.md"), "# Warmup\nHealth longevity biomarkers protocols supplements wellness.", "utf-8");

    const store = await getOrCreateStore("_warmup");
    await store.update({ collections: ["memory"] });
    await store.embed();
    console.log("  > Embedding model loaded");

    await store.search({ queries: [{ type: "lex", query: "longevity wellness" }, { type: "vec", query: "longevity wellness" }], collection: "memory", limit: 1, rerank: true });
    console.log("  > Embedding + reranker models loaded");

    modelsReady = true;
    console.log("QMD models loaded and ready");
  } catch (err) {
    console.error("Model pre-load failed (will retry on first request):", err.message);
  }

  // Keep models hot — lightweight search every 4 min
  setInterval(async () => {
    try {
      const store = stores.get("_warmup");
      if (store) {
        await store.search({ queries: [{ type: "lex", query: "health" }, { type: "vec", query: "health" }], collection: "memory", limit: 1, rerank: true });
      }
    } catch (err) {
      console.error("Model keepalive failed:", err.message);
    }
  }, 4 * 60 * 1000);
});

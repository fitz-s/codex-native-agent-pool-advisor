#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const STATE_VERSION = 1;
const DEFAULT_AGENT_CAP = 6;
const DEFAULT_WARN_REMAINING = 1;
const RUNNING_TTL_MS = 12 * 60 * 60 * 1000;
const TRANSCRIPT_SCAN_LIMIT_BYTES = 96 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 12 * 1024 * 1024;
const CHILD_SESSION_SCAN_MS = 36 * 60 * 60 * 1000;
const SESSION_CAPACITY_GUIDANCE_TTL_MS = 24 * 60 * 60 * 1000;
const PROMPT_CAPACITY_GUIDANCE_TTL_MS = 2 * 60 * 60 * 1000;
const PROMPT_DELEGATION_GUIDANCE_TTL_MS = 90 * 60 * 1000;
const PROMPT_CHILD_NO_SPAWN_GUIDANCE_TTL_MS = 90 * 60 * 1000;
const SPAWN_RESERVATION_TTL_MS = 90 * 1000;
const STATE_LOCK_WAIT_MS = 2500;
const STATE_LOCK_STALE_MS = 10000;
const NATIVE_EDGE_QUERY_TIMEOUT_MS = 750;
const NATIVE_EDGE_QUERY_MAX_BUFFER = 1024 * 1024;
const NATIVE_EDGE_TERMINAL_TAIL_BYTES = 2 * 1024 * 1024;
const NATIVE_EDGE_REPAIR_BATCH = 50;
const NATIVE_EDGE_MAINTENANCE_TTL_MS = 6 * 60 * 60 * 1000;
const ADVISOR_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMMAND_NAME = "native-agent-pool-advisor";
const DEFAULT_STATE_DB_NAME = "state_5.sqlite";
const DEFAULT_EXPLORER_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_EXPLORER_FALLBACK_MODEL = "gpt-5.4-mini";
const execFileAsync = promisify(execFile);
const LOCK_UNAVAILABLE = Symbol("native-agent-pool-advisor-lock-unavailable");
let runtimeOptionsCache = {
  defaultAgentCap: DEFAULT_AGENT_CAP,
  warnRemaining: DEFAULT_WARN_REMAINING,
  stateDbName: DEFAULT_STATE_DB_NAME,
  stateDbPathOverride: "",
  explorerPreferredModel: DEFAULT_EXPLORER_MODEL,
  explorerFallbackModel: DEFAULT_EXPLORER_FALLBACK_MODEL,
  explorerAllowedModels: [DEFAULT_EXPLORER_MODEL, DEFAULT_EXPLORER_FALLBACK_MODEL],
};

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function compactOneLine(value, maxLength = 96) {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function readStdinJson() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return safeObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function codexHome() {
  const explicit = safeString(process.env.CODEX_HOME).trim();
  if (explicit) return explicit;
  const home = safeString(process.env.HOME).trim();
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set for native-agent-pool-advisor");
}

function statePath() {
  return join(codexHome(), "state", "native-agent-pool-advisor.json");
}

function stateLockPath() {
  return join(codexHome(), "state", "native-agent-pool-advisor.lock");
}

function configPath() {
  return join(codexHome(), "config.toml");
}

function advisorConfigPath() {
  return join(codexHome(), "native-agent-pool-advisor.config.json");
}

function sessionsRoot() {
  return join(codexHome(), "sessions");
}

function stateDbPath() {
  if (runtimeOptionsCache.stateDbPathOverride) return runtimeOptionsCache.stateDbPathOverride;
  return join(codexHome(), runtimeOptionsCache.stateDbName || DEFAULT_STATE_DB_NAME);
}

function advisorLogPath() {
  return join(codexHome(), "log", `${COMMAND_NAME}.log`);
}

async function appendAdvisorLog(record) {
  try {
    const path = advisorLogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
      flag: "a",
    });
  } catch {
    // Logging is diagnostic only.
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

function parseStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => safeString(item).trim()).filter(Boolean);
  }
  return safeString(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => safeString(value).trim()).filter(Boolean))];
}

function readFirstString(...values) {
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return "";
}

function readFirstPositiveInteger(fallback, ...values) {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

async function readAdvisorConfig() {
  const raw = await readText(advisorConfigPath());
  if (!raw.trim()) return {};
  try {
    return safeObject(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

async function loadRuntimeOptions() {
  const config = await readAdvisorConfig();
  const models = safeObject(config.models) ?? {};
  const defaults = safeObject(config.defaults) ?? {};
  const paths = safeObject(config.paths) ?? {};

  const explicitExplorerModels = parseStringList(
    process.env.NATIVE_AGENT_POOL_EXPLORER_MODELS
      ?? models.explorer_models
      ?? models.explorerModels
      ?? models.allowedExplorerModels
      ?? models.explorer,
  );
  const preferred = readFirstString(
    process.env.NATIVE_AGENT_POOL_EXPLORER_MODEL,
    models.explorer_preferred,
    models.explorerPreferred,
    models.preferredExplorer,
    explicitExplorerModels[0],
    DEFAULT_EXPLORER_MODEL,
  );
  const fallback = readFirstString(
    process.env.NATIVE_AGENT_POOL_EXPLORER_FALLBACK_MODEL,
    models.explorer_fallback,
    models.explorerFallback,
    models.fallbackExplorer,
    explicitExplorerModels[1],
    explicitExplorerModels[0],
    DEFAULT_EXPLORER_FALLBACK_MODEL,
  );

  runtimeOptionsCache = {
    defaultAgentCap: readFirstPositiveInteger(
      DEFAULT_AGENT_CAP,
      process.env.NATIVE_AGENT_POOL_DEFAULT_CAP,
      defaults.agent_cap,
      defaults.agentCap,
      defaults.defaultAgentCap,
    ),
    warnRemaining: readFirstPositiveInteger(
      DEFAULT_WARN_REMAINING,
      process.env.NATIVE_AGENT_POOL_WARN_REMAINING,
      defaults.warn_remaining,
      defaults.warnRemaining,
    ),
    stateDbName: readFirstString(
      process.env.NATIVE_AGENT_POOL_STATE_DB_NAME,
      paths.state_db_name,
      paths.stateDbName,
      DEFAULT_STATE_DB_NAME,
    ),
    stateDbPathOverride: readFirstString(
      process.env.NATIVE_AGENT_POOL_STATE_DB_PATH,
      paths.state_db_path,
      paths.stateDbPath,
    ),
    explorerPreferredModel: preferred,
    explorerFallbackModel: fallback,
    explorerAllowedModels: uniqueStrings([
      ...explicitExplorerModels,
      preferred,
      fallback,
    ]),
  };
}

async function readAgentCap() {
  const raw = await readText(configPath());
  let inAgentsSection = false;
  let parsed = runtimeOptionsCache.defaultAgentCap;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]\s*$/);
    if (section) {
      inAgentsSection = section[1].trim() === "agents";
      continue;
    }
    if (!inAgentsSection) continue;
    const match = trimmed.match(/^max_threads\s*=\s*(\d+)\s*(?:#.*)?$/);
    if (match) {
      parsed = Number.parseInt(match[1], 10);
      break;
    }
  }
  return Number.isInteger(parsed) && parsed > 0 ? parsed : runtimeOptionsCache.defaultAgentCap;
}

function explorerModel() {
  return runtimeOptionsCache.explorerPreferredModel || DEFAULT_EXPLORER_MODEL;
}

function explorerFallbackModel() {
  return runtimeOptionsCache.explorerFallbackModel || DEFAULT_EXPLORER_FALLBACK_MODEL;
}

function explorerModels() {
  const models = runtimeOptionsCache.explorerAllowedModels ?? [];
  return models.length > 0 ? models : [DEFAULT_EXPLORER_MODEL, DEFAULT_EXPLORER_FALLBACK_MODEL];
}

function explorerModelListText() {
  return explorerModels().join(", ");
}

function warnRemaining() {
  return Math.max(0, runtimeOptionsCache.warnRemaining ?? DEFAULT_WARN_REMAINING);
}

function emptyState() {
  return {
    version: STATE_VERSION,
    updated_at: new Date(0).toISOString(),
    last_native_edge_maintenance_at: "",
    last_native_pool_reset_at: "",
    native_pool_reset_threads: {},
    native_pool_pruned_parent_at: {},
    sessions: {},
  };
}

async function readState() {
  const path = statePath();
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      version: STATE_VERSION,
      updated_at: safeString(parsed.updated_at) || new Date(0).toISOString(),
      last_native_edge_maintenance_at: safeString(parsed.last_native_edge_maintenance_at),
      last_native_pool_reset_at: safeString(parsed.last_native_pool_reset_at),
      native_pool_reset_threads:
        parsed.native_pool_reset_threads
          && typeof parsed.native_pool_reset_threads === "object"
          && !Array.isArray(parsed.native_pool_reset_threads)
          ? parsed.native_pool_reset_threads
          : {},
      native_pool_pruned_parent_at:
        parsed.native_pool_pruned_parent_at
          && typeof parsed.native_pool_pruned_parent_at === "object"
          && !Array.isArray(parsed.native_pool_pruned_parent_at)
          ? parsed.native_pool_pruned_parent_at
          : {},
      sessions:
        parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {},
    };
  } catch {
    return emptyState();
  }
}

async function writeState(state) {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStateLock() {
  const lockPath = stateLockPath();
  const ownerPath = join(lockPath, "owner");
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  const writeOwner = async () => {
    await writeFile(ownerPath, `${process.pid} ${new Date().toISOString()}\n`);
  };

  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      await writeOwner();
      return {
        touch: writeOwner,
        release: async () => {
          await rm(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return null;
      }
      try {
        let stats;
        try {
          stats = await stat(ownerPath);
        } catch {
          stats = await stat(lockPath);
        }
        if (Date.now() - stats.mtimeMs > STATE_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock disappeared between attempts.
      }
      await sleep(25 + Math.floor(Math.random() * 30));
    }
  }

  return null;
}

async function withStateLock(work) {
  const lock = await acquireStateLock();
  if (!lock) return LOCK_UNAVAILABLE;
  const heartbeat = setInterval(() => {
    lock.touch().catch(() => {});
  }, Math.max(1000, Math.floor(STATE_LOCK_STALE_MS / 3)));
  heartbeat.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await lock.release();
  }
}

function hookEventName(payload) {
  return safeString(
    payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? payload.name,
  ).trim();
}

function toolName(payload) {
  return safeString(payload.tool_name ?? payload.toolName).trim();
}

function promptText(payload) {
  return safeString(
    payload.prompt ?? payload.user_prompt ?? payload.userPrompt ?? payload.message ?? payload.text,
  ).trim();
}

function isManagedBridgeInvocation() {
  return safeString(process.env.OMX_NATIVE_AGENT_ADVISOR_BRIDGE).trim() === "1";
}

function normalizeToolName(name) {
  return safeString(name).trim().replace(/^functions\./, "");
}

function isAgentTool(name) {
  return ["spawn_agent", "wait_agent", "close_agent"].includes(normalizeToolName(name));
}

function normalizeNestedToolName(name) {
  const raw = safeString(name).trim();
  if (!raw) return "";
  const withoutFunctionPrefix = raw.replace(/^functions\./, "");
  if (isAgentTool(withoutFunctionPrefix)) return normalizeToolName(withoutFunctionPrefix);
  const lastSegment = withoutFunctionPrefix.split(".").pop() || withoutFunctionPrefix;
  return isAgentTool(lastSegment) ? normalizeToolName(lastSegment) : "";
}

function nestedToolInput(value) {
  return safeObject(value?.parameters)
    ?? safeObject(value?.arguments)
    ?? safeObject(value?.tool_input)
    ?? safeObject(value?.toolInput)
    ?? {};
}

function collectNestedAgentOperations(value, operations = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedAgentOperations(item, operations);
    return operations;
  }
  if (!value || typeof value !== "object") return operations;

  const nestedName = normalizeNestedToolName(
    value.recipient_name
      ?? value.recipientName
      ?? value.tool_name
      ?? value.toolName
      ?? value.name,
  );
  if (nestedName) {
    operations.push({
      name: nestedName,
      input: nestedToolInput(value),
      source: "nested",
    });
  }

  for (const key of ["tool_uses", "toolUses", "tools", "calls", "tool_calls", "toolCalls"]) {
    if (value[key]) collectNestedAgentOperations(value[key], operations);
  }
  return operations;
}

function agentOperations(payload, directName = "") {
  const operations = [];
  const direct = normalizeNestedToolName(directName);
  if (direct) {
    operations.push({ name: direct, input: toolInput(payload), source: "direct" });
  }
  collectNestedAgentOperations(toolInput(payload), operations);
  return operations;
}

function isToolHookEvent(eventName) {
  return eventName === "PreToolUse" || eventName === "PostToolUse";
}

function stableSessionKey(payload) {
  const direct = safeString(payload.session_id ?? payload.sessionId).trim();
  if (direct) return direct;
  const transcript = safeString(payload.transcript_path ?? payload.transcriptPath).trim();
  if (transcript) return `transcript:${hashText(transcript)}`;
  const cwd = safeString(payload.cwd).trim() || process.cwd();
  return `cwd:${hashText(cwd)}`;
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function transcriptPath(payload) {
  return safeString(payload.transcript_path ?? payload.transcriptPath).trim();
}

async function readFilePrefix(path, byteLimit = 64 * 1024) {
  if (!path) return "";
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    try {
      await handle?.close();
    } catch {
      // best effort
    }
  }
}

function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    return safeObject(parsed);
  } catch {
    return null;
  }
}

function getSessionMetaPayload(record) {
  if (record?.type !== "session_meta") return null;
  return safeObject(record.payload);
}

function sessionMetaFromText(text) {
  for (const line of safeString(text).split(/\r?\n/)) {
    if (!line.includes('"session_meta"')) continue;
    const meta = getSessionMetaPayload(parseJsonLine(line));
    if (meta) return meta;
  }
  return null;
}

async function sessionMetaFromTranscript(path) {
  return sessionMetaFromText(await readFilePrefix(path));
}

async function sessionIdentity(payload) {
  const transcript = transcriptPath(payload);
  const transcriptMeta = await sessionMetaFromTranscript(transcript);
  const transcriptThreadId = safeString(transcriptMeta?.id).trim();
  const directThreadId = safeString(payload.session_id ?? payload.sessionId ?? payload.thread_id ?? payload.threadId).trim();
  const threadId = transcriptThreadId || directThreadId;
  const parentThreadId = parentThreadIdFromChildMeta(transcriptMeta) || directParentThreadId(payload);
  const poolThreadId = parentThreadId || threadId;
  return {
    threadId,
    parentThreadId,
    poolThreadId,
    transcript,
    key: poolThreadId ? `thread:${poolThreadId}` : stableSessionKey(payload),
    isChildSession: Boolean(parentThreadId) || directChildSessionFlag(payload),
  };
}

async function readTranscriptForPool(path) {
  if (!path) return "";
  try {
    const stats = await stat(path);
    if (stats.size <= TRANSCRIPT_SCAN_LIMIT_BYTES) {
      return await readFile(path, "utf-8");
    }
    const start = Math.max(0, stats.size - TRANSCRIPT_TAIL_BYTES);
    let handle;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(stats.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      try {
        await handle?.close();
      } catch {
        // best effort
      }
    }
  } catch {
    return "";
  }
}

function parseToolArguments(item) {
  const raw = item?.arguments;
  if (typeof raw === "string") {
    try {
      return safeObject(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }
  return safeObject(raw) ?? {};
}

function eventTimestampMs(record) {
  const parsed = Date.parse(safeString(record?.timestamp));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parentThreadIdFromChildMeta(meta) {
  const source = safeObject(meta?.source);
  const subagent = safeObject(source?.subagent);
  const threadSpawn = safeObject(subagent?.thread_spawn);
  return safeString(threadSpawn?.parent_thread_id).trim();
}

function directParentThreadId(payload) {
  const direct = safeString(payload.parent_thread_id ?? payload.parentThreadId).trim();
  if (direct) return direct;
  if (parentThreadIdFromChildMeta(payload)) return parentThreadIdFromChildMeta(payload);
  const source = safeObject(payload.source);
  return source ? parentThreadIdFromChildMeta({ source }) : "";
}

function directChildSessionFlag(payload) {
  if (safeString(payload.thread_source ?? payload.threadSource).trim() === "subagent") return true;
  if (parentThreadIdFromChildMeta(payload)) return true;
  const source = safeObject(payload.source);
  return Boolean(source && parentThreadIdFromChildMeta({ source }));
}

function emptyTranscriptPool() {
  return {
    active: new Set(),
    spawned: new Set(),
    closed: new Set(),
    failedSpawns: 0,
    failedCloses: 0,
    capHitAtMs: 0,
    lastCloseAtMs: 0,
    scanned: false,
    truncated: false,
  };
}

function parseTranscriptPool(text, parentThreadId = "", sinceMs = 0) {
  const pool = emptyTranscriptPool();
  if (!text.trim()) return pool;
  pool.scanned = true;
  pool.truncated = !text.startsWith("{");
  const pendingSpawnCalls = new Map();
  const pendingCloseCalls = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = parseJsonLine(line);
    if (!record) continue;
    const recordMs = eventTimestampMs(record);
    if (sinceMs > 0 && recordMs > 0 && recordMs < sinceMs) continue;

    const payload = safeObject(record.payload);
    if (record.type === "event_msg" && payload?.type === "collab_agent_spawn_end") {
      const sender = safeString(payload.sender_thread_id).trim();
      if (parentThreadId && sender && sender !== parentThreadId) continue;

      const newThreadId = safeString(payload.new_thread_id).trim();
      if (newThreadId) {
        pool.spawned.add(newThreadId);
        pool.active.add(newThreadId);
      } else {
        pool.failedSpawns += 1;
        if (textLooksSpawnCapacityFailure(JSON.stringify(payload ?? ""))) {
          pool.capHitAtMs = Math.max(pool.capHitAtMs, eventTimestampMs(record));
        }
      }
      continue;
    }

    if (record.type !== "response_item") continue;
    if (payload?.type === "function_call_output") {
      const callId = safeString(payload.call_id ?? payload.callId).trim();
      if (callId && pendingSpawnCalls.has(callId)) {
        pendingSpawnCalls.delete(callId);
        const output = payload.output ?? payload.result ?? "";
        const spawnedIds = [...collectAgentIdsFromValue(output, new Set(), "agent_id")];
        if (spawnedIds.length > 0) {
          for (const id of spawnedIds) {
            pool.spawned.add(id);
            pool.active.add(id);
          }
        } else {
          pool.failedSpawns += 1;
          if (textLooksSpawnCapacityFailure(safeString(output))) {
            pool.capHitAtMs = Math.max(pool.capHitAtMs, eventTimestampMs(record));
          }
        }
        continue;
      }
      const closeIds = callId ? pendingCloseCalls.get(callId) : null;
      if (closeIds) {
        pendingCloseCalls.delete(callId);
        if (textLooksCloseFailed(safeString(payload.output ?? payload.result ?? ""))) {
          pool.failedCloses += closeIds.length;
          continue;
        }
        for (const id of closeIds) {
          pool.closed.add(id);
          pool.active.delete(id);
          pool.lastCloseAtMs = Math.max(pool.lastCloseAtMs, eventTimestampMs(record));
        }
      }
      continue;
    }
    if (payload?.type !== "function_call") continue;

    const normalized = normalizeToolName(safeString(payload.name));
    if (normalized === "spawn_agent") {
      const callId = safeString(payload.call_id ?? payload.callId).trim();
      if (callId) pendingSpawnCalls.set(callId, true);
      continue;
    }
    if (normalized !== "close_agent") continue;
    const closeIds = [...collectAgentIdsFromValue(parseToolArguments(payload).target, new Set(), "target")];
    const callId = safeString(payload.call_id ?? payload.callId).trim();
    if (callId && closeIds.length > 0) {
      pendingCloseCalls.set(callId, closeIds);
      continue;
    }
    for (const id of closeIds) {
      pool.closed.add(id);
      pool.active.delete(id);
      pool.lastCloseAtMs = Math.max(pool.lastCloseAtMs, eventTimestampMs(record));
    }
  }

  return pool;
}

function datePathParts(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day];
}

function childSessionDirs(nowMs) {
  const dirs = new Set();
  for (const offsetMs of [0, 24 * 60 * 60 * 1000, 48 * 60 * 60 * 1000]) {
    const date = new Date(nowMs - offsetMs);
    dirs.add(join(sessionsRoot(), ...datePathParts(date)));
  }
  return [...dirs];
}

async function discoverRecentChildSessionIds(parentThreadId, nowMs, sinceMs = 0) {
  const ids = new Set();
  if (!parentThreadId) return ids;

  for (const dir of childSessionDirs(nowMs)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      let stats;
      try {
        stats = await stat(path);
      } catch {
        continue;
      }
      if (nowMs - stats.mtimeMs > CHILD_SESSION_SCAN_MS) continue;
      if (sinceMs > 0 && stats.mtimeMs < sinceMs) continue;

      const prefix = await readFilePrefix(path);
      for (const line of prefix.split(/\r?\n/)) {
      if (!line.includes('"session_meta"')) continue;
      const record = parseJsonLine(line);
      const recordMs = eventTimestampMs(record);
      if (sinceMs > 0 && recordMs > 0 && recordMs < sinceMs) break;
      const meta = getSessionMetaPayload(record);
      if (parentThreadIdFromChildMeta(meta) !== parentThreadId) break;
      const id = safeString(meta?.id).trim();
        if (id) ids.add(id);
        break;
      }
    }
  }

  return ids;
}

function emptyNativeThreadEdges() {
  return {
    active: new Set(),
    closed: new Set(),
    terminal: new Set(),
    lanes: new Map(),
    checked: false,
    failed: false,
    repaired: 0,
  };
}

function sqlString(value) {
  return `'${safeString(value).replace(/'/g, "''")}'`;
}

function parseSqliteJsonOutput(stdout) {
  const text = safeString(stdout).trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    const lastArray = text.lastIndexOf("\n[");
    if (lastArray >= 0) {
      try {
        return JSON.parse(text.slice(lastArray + 1));
      } catch {
        return [];
      }
    }
  }
  return [];
}

async function transcriptHasTaskComplete(path) {
  if (!path) return false;
  try {
    const stats = await stat(path);
    const start = Math.max(0, stats.size - NATIVE_EDGE_TERMINAL_TAIL_BYTES);
    let handle;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(stats.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      for (const line of buffer.subarray(0, bytesRead).toString("utf-8").split(/\r?\n/)) {
        if (!line.includes('"task_complete"')) continue;
        const record = parseJsonLine(line);
        const payload = safeObject(record?.payload);
        if (record?.type === "event_msg" && payload?.type === "task_complete") {
          return true;
        }
      }
      return false;
    } finally {
      try {
        await handle?.close();
      } catch {
        // best effort
      }
    }
  } catch {
    return false;
  }
}

async function repairClosedNativeEdges(parentThreadId, closedIds) {
  const ids = [...(closedIds ?? [])].filter(Boolean).slice(0, NATIVE_EDGE_REPAIR_BATCH);
  if (!parentThreadId || ids.length === 0) return 0;
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;

  const sql = [
    "pragma busy_timeout=250;",
    "update thread_spawn_edges",
    "set status='closed'",
    `where parent_thread_id=${sqlString(parentThreadId)}`,
    "and status!='closed'",
    `and child_thread_id in (${ids.map(sqlString).join(",")});`,
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    const changed = Number(rows?.[0]?.changed ?? 0);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_edge_close_repair",
        parent_thread_id: parentThreadId,
        requested: ids.length,
        changed,
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
  }
}

async function maintainNativePoolStorage(state, nowMs, nowIso) {
  const last = msFromIso(state.last_native_edge_maintenance_at);
  if (last && nowMs - last < NATIVE_EDGE_MAINTENANCE_TTL_MS) return;
  state.last_native_edge_maintenance_at = nowIso;
}

async function discoverNativeThreadEdges(parentThreadId) {
  const edges = emptyNativeThreadEdges();
  if (!parentThreadId) return edges;

  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return edges;

  const sql = [
    "select e.child_thread_id,e.status,t.rollout_path,t.title,t.agent_role,t.model,t.reasoning_effort,t.agent_nickname,t.cwd,t.updated_at",
    "from thread_spawn_edges e",
    "left join threads t on t.id=e.child_thread_id",
    `where e.parent_thread_id=${sqlString(parentThreadId)}`,
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    if (!Array.isArray(rows)) return edges;

    edges.checked = true;
    for (const row of rows) {
      const childId = safeString(row?.child_thread_id).trim();
      if (!childId) continue;
      edges.lanes.set(childId, {
        id: childId,
        parent_thread_id: parentThreadId,
        title: compactOneLine(row?.title, 72),
        role: compactOneLine(row?.agent_role, 32),
        model: compactOneLine(row?.model, 48),
        reasoning_effort: compactOneLine(row?.reasoning_effort, 16),
        nickname: compactOneLine(row?.agent_nickname, 32),
        cwd: compactOneLine(row?.cwd, 72),
        updated_at: row?.updated_at,
      });
      const status = safeString(row?.status).trim().toLowerCase();
      if (status === "closed") {
        edges.closed.add(childId);
      } else {
        if (await transcriptHasTaskComplete(safeString(row?.rollout_path).trim())) {
          edges.terminal.add(childId);
        } else {
          edges.active.add(childId);
        }
      }
    }
  } catch {
    edges.failed = true;
  }

  return edges;
}

async function findRecentTranscriptByThreadId(threadId, nowMs, preferredPath = "") {
  if (!threadId) return "";

  if (preferredPath) {
    const meta = await sessionMetaFromTranscript(preferredPath);
    if (safeString(meta?.id).trim() === threadId) return preferredPath;
  }

  for (const dir of childSessionDirs(nowMs)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      let stats;
      try {
        stats = await stat(path);
      } catch {
        continue;
      }
      if (nowMs - stats.mtimeMs > CHILD_SESSION_SCAN_MS) continue;

      const meta = await sessionMetaFromTranscript(path);
      if (safeString(meta?.id).trim() === threadId) return path;
    }
  }

  return "";
}

function nativePoolResetMs(state, poolThreadId = "") {
  const globalResetMs = msFromIso(state?.last_native_pool_reset_at);
  const threadResetMs = poolThreadId
    ? msFromIso(safeString(state?.native_pool_reset_threads?.[poolThreadId]))
    : 0;
  return Math.max(globalResetMs, threadResetMs);
}

async function collectPoolEvidence(identity, nowMs, resetAtMs = 0) {
  const poolThreadId = identity.poolThreadId || identity.threadId;
  const preferredPath = identity.threadId === poolThreadId ? identity.transcript : "";
  const poolTranscript = await findRecentTranscriptByThreadId(
    poolThreadId,
    nowMs,
    preferredPath || identity.transcript,
  );
  const transcriptPool = parseTranscriptPool(
    await readTranscriptForPool(poolTranscript || identity.transcript),
    poolThreadId,
    resetAtMs,
  );
  const [childSessionIds, nativeThreadEdges] = await Promise.all([
    discoverRecentChildSessionIds(poolThreadId, nowMs, resetAtMs),
    discoverNativeThreadEdges(poolThreadId),
  ]);
  return { transcriptPool, childSessionIds, nativeThreadEdges, poolThreadId };
}

function normalizeSession(state, sessionKey) {
  const raw = state.sessions[sessionKey];
  if (!raw || typeof raw !== "object") {
    state.sessions[sessionKey] = {
      session_id: sessionKey,
      updated_at: new Date(0).toISOString(),
      agents: {},
      spawn_reservations: {},
    };
    return state.sessions[sessionKey];
  }
  if (!raw.agents || typeof raw.agents !== "object" || Array.isArray(raw.agents)) {
    raw.agents = {};
  }
  if (!raw.spawn_reservations || typeof raw.spawn_reservations !== "object" || Array.isArray(raw.spawn_reservations)) {
    raw.spawn_reservations = {};
  }
  raw.session_id = safeString(raw.session_id) || sessionKey;
  raw.updated_at = safeString(raw.updated_at) || new Date(0).toISOString();
  return raw;
}

function pruneStaleRunningAgents(session, nowMs) {
  for (const [id, agent] of Object.entries(session.agents ?? {})) {
    if (!agent || typeof agent !== "object") {
      delete session.agents[id];
      continue;
    }
    if (agent.status === "closed") {
      delete session.agents[id];
      continue;
    }
    if (agent.status !== "running") continue;
    const lastSeen = Date.parse(safeString(agent.last_seen_at) || safeString(agent.spawned_at));
    if (Number.isFinite(lastSeen) && nowMs - lastSeen > RUNNING_TTL_MS) {
      delete session.agents[id];
    }
  }
}

function pruneSpawnReservations(session, nowMs) {
  for (const [key, reservation] of Object.entries(session.spawn_reservations ?? {})) {
    if (!reservation || typeof reservation !== "object") {
      delete session.spawn_reservations[key];
      continue;
    }
    const expiresAt = Date.parse(safeString(reservation.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      delete session.spawn_reservations[key];
    }
  }
}

function pruneAdvisorSessions(state, nowMs) {
  for (const [key, session] of Object.entries(state.sessions ?? {})) {
    if (!session || typeof session !== "object") {
      delete state.sessions[key];
      continue;
    }
    const hasAgents = Object.keys(session.agents ?? {}).length > 0;
    const hasReservations = Object.keys(session.spawn_reservations ?? {}).length > 0;
    if (hasAgents || hasReservations) continue;
    const updatedAt = msFromIso(session.updated_at);
    if (updatedAt > 0 && nowMs - updatedAt > ADVISOR_SESSION_RETENTION_MS) {
      delete state.sessions[key];
    }
  }
}

function toolInput(payload) {
  return safeObject(payload.tool_input ?? payload.toolInput) ?? {};
}

function requestedAgentType(payload) {
  const input = toolInput(payload);
  return safeString(input.agent_type ?? input.agentType ?? input.role).trim().toLowerCase();
}

function requestedModel(payload) {
  const input = toolInput(payload);
  return safeString(input.model).trim();
}

function isExplorerSpawnInput(payload) {
  return ["explore", "explorer"].includes(requestedAgentType(payload));
}

function hasExplorerModelRouteViolation(payload) {
  if (!isExplorerSpawnInput(payload)) return false;
  return !explorerModels().includes(requestedModel(payload));
}

function operationAgentType(operation) {
  return safeString(operation?.input?.agent_type ?? operation?.input?.agentType ?? operation?.input?.role)
    .trim()
    .toLowerCase();
}

function operationModel(operation) {
  return safeString(operation?.input?.model).trim();
}

function operationReasoningEffort(operation) {
  return safeString(operation?.input?.reasoning_effort ?? operation?.input?.reasoningEffort).trim();
}

function operationPromptText(operation) {
  const input = safeObject(operation?.input) ?? {};
  const parts = [
    input.message,
    input.prompt,
    input.task,
    input.instructions,
    input.input,
  ].map(safeString).filter(Boolean);
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (item && typeof item === "object") {
        parts.push(safeString(item.text));
        parts.push(safeString(item.name));
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

function hasSpawnOperation(operations) {
  return operations.some((operation) => operation.name === "spawn_agent");
}

function spawnOperationCount(operations) {
  return operations.filter((operation) => operation.name === "spawn_agent").length;
}

function hasExplorerModelRouteViolationInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (!["explore", "explorer"].includes(operationAgentType(operation))) return false;
    return !explorerModels().includes(operationModel(operation));
  });
}

function countMatches(text, pattern) {
  return [...safeString(text).matchAll(pattern)].length;
}

function hasDistinctExplorerFallback() {
  const preferred = explorerModel();
  const fallback = explorerFallbackModel();
  return Boolean(fallback && preferred && fallback !== preferred && explorerModels().includes(fallback));
}

function looksLikeComplexExplorerPrompt(text) {
  const raw = safeString(text);
  const normalized = raw.toLowerCase();
  if (!normalized.trim()) return false;

  const arrows = countMatches(raw, /(?:->|→)/g);
  const fileRefs = countMatches(raw, /\b[\w./-]+\.(?:py|ts|tsx|js|mjs|json|toml|yaml|yml|md)\b/g);
  const reasoningHits = countMatches(
    normalized,
    /\b(?:analy[sz]e|trace|classify|determine|whether|verify|validate|audit|review|root cause|policy|strategy|strategic|mathematical|math|sizing|discount|fallback|tests?|settings?|config|runtime|execution|posterior|kelly|semantic|intent|branch|end-to-end|e2e|verdict|conclusion)\b/g,
  );
  const hasDomainReasoningMarker = /(?:mathematic|strategic|posterior|kelly|execution-policy|policy mismatch|semantic|live order|limit price|fallbacks?)/i.test(raw);
  const asksForClassification = /(?:return whether|classify|verdict|conclusion|is intended|bug|mismatch)/i.test(raw);

  return (
    raw.length > 900
    || (arrows >= 2 && reasoningHits >= 3)
    || (fileRefs >= 4 && reasoningHits >= 3)
    || (hasDomainReasoningMarker && reasoningHits >= 3)
    || (asksForClassification && reasoningHits >= 4)
  );
}

function hasPreferredExplorerContractAdvisoryInOperations(operations) {
  if (!hasDistinctExplorerFallback()) return false;
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (!["explore", "explorer"].includes(operationAgentType(operation))) return false;
    if (operationModel(operation) !== explorerModel()) return false;
    const effort = operationReasoningEffort(operation);
    return (effort && effort !== "low") || looksLikeComplexExplorerPrompt(operationPromptText(operation));
  });
}

function looksLikeNarrowScanPrompt(text) {
  const raw = safeString(text);
  const normalized = raw.toLowerCase();
  if (!normalized.trim()) return false;
  const scanHits = countMatches(
    normalized,
    /\b(?:rg|grep|find|search|lookup|map|list|scan|symbols?|references?|callers?|callees?|file:line|anchors?)\b/g,
  );
  const conclusionHits = countMatches(
    normalized,
    /\b(?:analy[sz]e|synthesize|classify|determine|verdict|conclusion|approve|revise|block|fix|edit|implement)\b/g,
  );
  return raw.length <= 500 && scanHits >= 1 && conclusionHits === 0;
}

function hasFallbackExplorerContractAdvisoryInOperations(operations) {
  if (!hasDistinctExplorerFallback()) return false;
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (!["explore", "explorer"].includes(operationAgentType(operation))) return false;
    if (operationModel(operation) !== explorerFallbackModel()) return false;
    return looksLikeNarrowScanPrompt(operationPromptText(operation));
  });
}

function hasExplorerContractAdvisoryInOperations(operations) {
  return hasPreferredExplorerContractAdvisoryInOperations(operations)
    || hasFallbackExplorerContractAdvisoryInOperations(operations);
}

function toolResponse(payload) {
  return payload.tool_response ?? payload.toolResponse ?? payload.response ?? payload.result;
}

function operationResponseItemMatches(item, operation) {
  if (!item || typeof item !== "object") return false;
  const name = normalizeNestedToolName(
    item.recipient_name
      ?? item.recipientName
      ?? item.tool_name
      ?? item.toolName
      ?? item.name,
  );
  return name && name === operation?.name;
}

function unwrapOperationResponseItem(item) {
  if (!item || typeof item !== "object") return item;
  return item.output ?? item.result ?? item.response ?? item.tool_response ?? item.toolResponse ?? item;
}

function operationResponse(payload, operation) {
  const response = toolResponse(payload);
  if (Array.isArray(response)) {
    const matched = response.find((item) => operationResponseItemMatches(item, operation));
    return matched ? unwrapOperationResponseItem(matched) : response;
  }
  if (response && typeof response === "object") {
    if (operationResponseItemMatches(response, operation)) {
      return unwrapOperationResponseItem(response);
    }
    for (const key of ["tool_uses", "toolUses", "results", "responses", "outputs"]) {
      if (Array.isArray(response[key])) {
        const matched = response[key].find((item) => operationResponseItemMatches(item, operation));
        if (matched) return unwrapOperationResponseItem(matched);
      }
    }
  }
  return response;
}

function payloadForOperation(payload, operation) {
  return {
    ...payload,
    tool_name: operation.name,
    toolName: operation.name,
    tool_input: operation.input ?? {},
    toolInput: operation.input ?? {},
    tool_response: operationResponse(payload, operation),
    toolResponse: operationResponse(payload, operation),
  };
}

function responseText(payload) {
  const response = toolResponse(payload);
  if (typeof response === "string") return response;
  try {
    return JSON.stringify(response ?? "");
  } catch {
    return "";
  }
}

function textLooksCloseFailed(text) {
  return /(?:无法关闭|close[^.!?\n]{0,80}(?:failed|error)|(?:failed|unable|cannot|could not)[^.!?\n]{0,80}close|unknown agent|agent not found|not found|invalid agent)/i.test(
    safeString(text),
  );
}

function textLooksSpawnCapacityFailure(text) {
  return /(?:collab spawn failed|agent thread limit reached|thread limit reached|pool[- ]?exhaustion|pool[^.!?\n]{0,80}(?:full|exhausted)|无法生成|不能启动|名额[^.!?\n]{0,80}满|数量[^.!?\n]{0,80}上限|线程上限|子代理[^.!?\n]{0,80}(?:上限|已满)|智能体[^.!?\n]{0,80}(?:上限|已满)|native[^.!?\n]{0,80}(?:agent|subagent)[^.!?\n]{0,80}(?:limit|cap)[^.!?\n]{0,80}(?:reached|full|exhausted)|(?:limit|cap)[^.!?\n]{0,80}(?:reached|full|exhausted)[^.!?\n]{0,80}native[^.!?\n]{0,80}(?:agent|subagent))/i.test(
    safeString(text),
  );
}

function closeLooksFailed(payload) {
  return textLooksCloseFailed(responseText(payload));
}

function toolCallId(payload) {
  return safeString(
    payload.tool_call_id
      ?? payload.toolCallId
      ?? payload.call_id
      ?? payload.callId
      ?? payload.tool_use_id
      ?? payload.toolUseId
      ?? payload.id,
  ).trim();
}

function reservationKey(payload, nowIso) {
  const direct = toolCallId(payload);
  if (direct) return `call:${direct}`;
  const inputHash = hashText(JSON.stringify(toolInput(payload)));
  return `fallback:${inputHash}:${nowIso}`;
}

function reserveSpawnSlot(session, payload, nowMs, nowIso, count = 1) {
  const key = reservationKey(payload, nowIso);
  session.spawn_reservations[key] = {
    key,
    count: Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1),
    reserved_at: nowIso,
    expires_at: new Date(nowMs + SPAWN_RESERVATION_TTL_MS).toISOString(),
    tool_input_hash: hashText(JSON.stringify(toolInput(payload))),
  };
}

function clearSpawnReservation(session, payload) {
  const direct = toolCallId(payload);
  if (direct) {
    delete session.spawn_reservations[`call:${direct}`];
    return;
  }
  const inputHash = hashText(JSON.stringify(toolInput(payload)));
  for (const [key, reservation] of Object.entries(session.spawn_reservations ?? {})) {
    if (reservation?.tool_input_hash === inputHash) {
      delete session.spawn_reservations[key];
      return;
    }
  }
}

function spawnReservationCount(session) {
  return Object.values(session.spawn_reservations ?? {}).reduce((total, reservation) => {
    const count = Number(reservation?.count ?? 1);
    return total + (Number.isFinite(count) && count > 0 ? Math.floor(count) : 1);
  }, 0);
}

function collectAgentIdsFromValue(value, ids = new Set(), keyHint = "") {
  if (typeof value === "string") {
    const text = value.trim();
    const keyLooksRelevant = /(?:^|_)(?:agent_?id|targets?|ids?|agent)(?:$|_)/i.test(keyHint);
    if (keyLooksRelevant && looksLikeAgentId(text)) ids.add(text);
    for (const match of text.matchAll(/(?:agent[_-]?id|target|id)["'\s:=]+([A-Za-z0-9_.:-]{6,})/gi)) {
      if (looksLikeAgentId(match[1])) ids.add(match[1]);
    }
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAgentIdsFromValue(item, ids, keyHint);
    return ids;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectAgentIdsFromValue(child, ids, key);
    }
  }
  return ids;
}

function looksLikeAgentId(value) {
  if (!value || value.length < 6 || value.length > 160) return false;
  if (/\s/.test(value)) return false;
  if (/^(unknown|null|undefined|completed|failed|success)$/i.test(value)) return false;
  return /^[A-Za-z0-9_.:-]+$/.test(value);
}

function collectSpawnedAgentIds(payload) {
  const response = toolResponse(payload);
  const ids = collectAgentIdsFromValue(response);
  return [...ids];
}

function collectCloseTargetIds(payload) {
  const input = toolInput(payload);
  const ids = new Set();
  collectAgentIdsFromValue(input.target, ids, "target");
  collectAgentIdsFromValue(input.targets, ids, "targets");
  return [...ids];
}

function collectWaitTargetIds(payload) {
  const input = toolInput(payload);
  const ids = new Set();
  collectAgentIdsFromValue(input.targets, ids, "targets");
  collectAgentIdsFromValue(input.target, ids, "target");
  return [...ids];
}

function waitLooksTerminal(payload) {
  const text = responseText(payload).toLowerCase();
  if (!text.trim()) return false;
  if (/timed?\s*out|timeout|running|in_progress|pending/.test(text)) return false;
  return /completed|complete|final|failed|cancelled|closed|done/.test(text);
}

function markSpawned(session, payload, nowIso) {
  const ids = collectSpawnedAgentIds(payload);
  for (const id of ids) {
    const existing = session.agents[id] && typeof session.agents[id] === "object"
      ? session.agents[id]
      : {};
    session.agents[id] = {
      id,
      status: "running",
      spawned_at: safeString(existing.spawned_at) || nowIso,
      last_seen_at: nowIso,
      role: safeString(toolInput(payload).agent_type ?? toolInput(payload).agentType),
    };
  }
}

function markWaited(session, payload, nowIso) {
  if (!waitLooksTerminal(payload)) return;
  for (const id of collectWaitTargetIds(payload)) {
    const existing = session.agents[id] && typeof session.agents[id] === "object"
      ? session.agents[id]
      : { id, spawned_at: nowIso };
    session.agents[id] = {
      ...existing,
      id,
      status: "terminal_not_closed",
      last_seen_at: nowIso,
      terminal_at: nowIso,
    };
  }
}

function markClosed(session, payload) {
  if (closeLooksFailed(payload)) return [];
  const ids = collectCloseTargetIds(payload);
  for (const id of ids) {
    delete session.agents[id];
  }
  return ids;
}

function looksLikeDelegationPrompt(prompt) {
  const normalized = safeString(prompt).toLowerCase();
  return /(?:\bspawn_agent\b|\bnative\s+(?:sub)?agents?\b|\bsubagents?\b|\bchild\s+agents?\b|\bagents?\b|\bpool\b|\bcap\b|\blimit\b|\bcritics?\b|\breviewers?\b|\breviews?\b|\bverifiers?\b|\bverif(?:y|ier|ication)\b|\bresearchers?\b|\baudit(?:or|ing)?\b|\bdelegate\b|\bparallel\b|\bfan[ -]?out\b|子代理|智能体|代理|上限|满池|名额|槽位|并行|派发|审查代理|验证代理|评审代理|复审代理|验收代理|审查|复核|评审|审计|验证|深度推理|第一性原理)/i.test(normalized);
}

function looksLikeRepoContextPrompt(prompt) {
  const normalized = safeString(prompt).toLowerCase();
  return /(?:\brg\b|\bgrep\b|\bglob\b|\bfind\b|\bscan\b|\bsearch\b|\blookup\b|\binspect\b|\btrace\b|\bdebug\b|\breview\b|\baudit\b|\brefactor\b|\bcodebase\b|\brepo(?:sitory)?\b|\bworkspace\b|\bsymbol\b|\breferences?\b|\bcallers?\b|\btests?\b|\bpytest\b|\bhooks?\b|\.claude|\.codex|agents\.md|spark|mini|子代理|智能体|代码库|代码|仓库|工作区|全局|搜索|检索|查找|定位|扫描|查看|阅读|排查|调试|审查|复核|重构|测试|上下文|污染|文件|符号|引用)/i.test(normalized);
}

function hasRecentCapacityPressure(session, nowMs) {
  const recentMs = 6 * 60 * 60 * 1000;
  const lastCapHit = msFromIso(session.last_cap_hit_at);
  const lastCloseFailed = msFromIso(session.last_close_failed_at);
  return (
    (lastCapHit > 0 && nowMs - lastCapHit < recentMs)
    || (lastCloseFailed > 0 && nowMs - lastCloseFailed < recentMs)
    || spawnReservationCount(session) > 0
  );
}

function hasPromptCapacityPressure(summary) {
  return Boolean(
    summary
      && (
        summary.occupied > 0
        || summary.cap_hit_after_last_close
        || summary.failed_closes > 0
        || summary.pending_spawn_reservations > 0
      ),
  );
}

function shouldEmitCapacityGuidance(eventName, prompt, session, nowMs, isChildSession, promptSummary = null, cap = DEFAULT_AGENT_CAP) {
  if (eventName === "SessionStart") {
    if (isChildSession) return false;
    const last = msFromIso(session.last_capacity_session_guidance_at);
    return !last || nowMs - last > SESSION_CAPACITY_GUIDANCE_TTL_MS;
  }

  if (eventName !== "UserPromptSubmit") return false;
  if (
    !looksLikeDelegationPrompt(prompt)
    && !hasRecentCapacityPressure(session, nowMs)
    && !hasPromptCapacityPressure(promptSummary)
  ) return false;

  const criticalPressure = Boolean(
    promptSummary
      && (
        remainingSpawnBudget(promptSummary, cap) <= warnRemaining()
        || promptSummary.cap_hit_after_last_close
      ),
  );
  if (criticalPressure) return true;

  const signature = hashText(prompt.trim().toLowerCase());
  const last = msFromIso(session.last_capacity_prompt_guidance_at);
  if (last && nowMs - last < PROMPT_CAPACITY_GUIDANCE_TTL_MS) return false;
  if (session.last_capacity_prompt_signature === signature && last) return false;
  return true;
}

function shouldEmitDelegationGuidance(eventName, prompt, session, nowMs, isChildSession) {
  if (eventName !== "UserPromptSubmit") return false;
  if (isChildSession) return false;
  if (!looksLikeRepoContextPrompt(prompt)) return false;

  const signature = hashText(prompt.trim().toLowerCase());
  const last = msFromIso(session.last_delegation_prompt_guidance_at);
  if (last && nowMs - last < PROMPT_DELEGATION_GUIDANCE_TTL_MS) return false;
  if (session.last_delegation_prompt_signature === signature && last) return false;
  return true;
}

function shouldEmitChildNoSpawnGuidance(eventName, prompt, session, nowMs, isChildSession) {
  if (eventName !== "UserPromptSubmit") return false;
  if (!isChildSession) return false;

  const signature = hashText(prompt.trim().toLowerCase());
  const last = msFromIso(session.last_child_no_spawn_guidance_at);
  if (last && nowMs - last < PROMPT_CHILD_NO_SPAWN_GUIDANCE_TTL_MS) return false;
  if (session.last_child_no_spawn_signature === signature && last) return false;
  return true;
}

function markCapacityGuidanceEmitted(eventName, prompt, session, nowIso) {
  if (eventName === "SessionStart") {
    session.last_capacity_session_guidance_at = nowIso;
    return;
  }
  if (eventName === "UserPromptSubmit") {
    session.last_capacity_prompt_guidance_at = nowIso;
    session.last_capacity_prompt_signature = hashText(prompt.trim().toLowerCase());
  }
}

function markDelegationGuidanceEmitted(prompt, session, nowIso) {
  session.last_delegation_prompt_guidance_at = nowIso;
  session.last_delegation_prompt_signature = hashText(prompt.trim().toLowerCase());
}

function markChildNoSpawnGuidanceEmitted(prompt, session, nowIso) {
  session.last_child_no_spawn_guidance_at = nowIso;
  session.last_child_no_spawn_signature = hashText(prompt.trim().toLowerCase());
}

function remainingSpawnBudget(summary, cap) {
  if (!summary) return cap;
  if (summary.cap_hit_after_last_close) return 0;
  return Math.max(0, cap - (summary.occupied ?? 0));
}

function nativeEdgeSummary(summary) {
  if (summary?.native_edge_checked) {
    const authority = summary.native_edge_authoritative ? "authoritative" : "fallback";
    return `open=${summary.native_edge_active}, terminal_open=${summary.native_edge_terminal ?? 0}, authority=${authority}`;
  }
  if (summary?.native_edge_failed) return "unavailable";
  return "not_checked";
}

function formatLaneSummary(lane) {
  const id = compactOneLine(lane?.id, 42) || "unknown";
  const parts = [id];
  const role = compactOneLine(lane?.role, 24);
  const model = compactOneLine(lane?.model, 36);
  const effort = compactOneLine(lane?.reasoning_effort, 12);
  const title = compactOneLine(lane?.title, 64);
  if (role) parts.push(`role=${role}`);
  if (model) parts.push(`model=${model}`);
  if (effort) parts.push(`effort=${effort}`);
  if (title) parts.push(`title="${title}"`);
  return parts.join(" ");
}

function formatTerminalLaneSummary(lane) {
  const base = formatLaneSummary(lane);
  const details = [];
  const parent = compactOneLine(lane?.parent_thread_id, 32);
  const updatedAt = Number(lane?.updated_at);
  if (parent) details.push(`parent=${parent}`);
  if (Number.isFinite(updatedAt) && updatedAt > 0) {
    details.push(`updated=${new Date(updatedAt * 1000).toISOString()}`);
  }
  details.push(`close_agent target=${compactOneLine(lane?.id, 42) || "unknown"}`);
  return `${base} (${details.join(", ")})`;
}

function terminalCloseTargetGuidance(summary) {
  const lanes = Array.isArray(summary?.native_terminal_lanes) ? summary.native_terminal_lanes : [];
  if (lanes.length === 0) return "";
  return `Stale completed native edge rows excluded from occupied budget: ${lanes.map(formatTerminalLaneSummary).join(" | ")}. If a listed lane is still reachable and useful, reuse it with send_input; if it is reachable but no longer useful, close_agent it. If it is not reachable, use explicit reset/repair tooling rather than treating it as live capacity.`;
}

function buildTurnBudgetGuidance(summary, cap) {
  if (!summary) return "";
  const remaining = remainingSpawnBudget(summary, cap);
  return [
    `Current native subagent budget: occupied=${summary.occupied}/${cap}, remaining_spawn_budget=${remaining}, ledger=${summary.tracked_occupied}, transcript_fallback=${summary.transcript_occupied}, native_current=${nativeEdgeSummary(summary)}, completed_not_closed=${summary.terminal}, reserved_spawns=${summary.pending_spawn_reservations}, cap_hit_after_last_close=${summary.cap_hit_after_last_close ? "yes" : "no"}.`,
    terminalCloseTargetGuidance(summary),
    "For this assistant response, maintain this as a hard local counter: every spawn_agent call consumes 1 immediately; wait_agent does not free a slot; close_agent frees a slot only after a successful close result.",
    "When remaining_spawn_budget is 0, do not call spawn_agent. Reuse a compatible completed lane with send_input, wait for active agents, continue locally, or close a no-longer-needed lane first.",
  ].filter(Boolean).join(" ");
}

function buildCapacityGuidance(eventName, cap, summary = null) {
  return [
    buildTurnBudgetGuidance(summary, cap),
    `Native subagent capacity protocol (launch sequencing only): this parent session has a native child-agent cap of ${cap}; some Codex/App spawn surfaces do not run PreToolUse before spawn_agent, so treat this as a hard self-enforced launch budget.`,
    "Do not batch native spawn_agent calls: if reviewer+verifier/critic/researcher lanes are useful, first reuse a compatible completed lane with send_input; otherwise launch at most one native subagent, wait for the spawn result or confirmed free-slot evidence, then decide whether one more is still worth it.",
    "Completed children preserve valuable task context and still consume slots until close succeeds; keep useful lanes open for related follow-up, and close only stale/irrelevant/wrong-role lanes when capacity is needed.",
    "If this thread already saw a pool-exhaustion failure and no later close is confirmed, do not call spawn_agent again in the same turn even when the local ledger estimates fewer than the cap.",
    "Do not restate/retry long child prompts after a capacity failure.",
    "This protocol does not decide whether to delegate, reuse, or close a lane; it only prevents wasteful native pool collisions.",
  ].filter(Boolean).join(" ");
}

function buildDelegationGuidance(cap) {
  return [
    `Codex context hygiene delegation protocol: treat native subagents as the default context-isolation layer for broad repo lookup, file/symbol mapping, grep-like scans, lightweight review probes, and bounded verification; the leader should preserve main-thread context for judgment, integration, and final decisions.`,
    `Explorer model routing: choose by output contract, risk, and state depth, not by a few complexity words. ${explorerModel()} is the near-instant scout lane: use it for bounded read-only probes, grep/file maps, symbol lookup, log filtering, candidate file:line anchors, hypothesis sampling, and fast evidence collection inside larger reasoning workflows.`,
    `${explorerFallbackModel()} is the reasoning explorer / light executor lane: use it for multi-hop code-path traces, compact evidence synthesis, small low-risk edits, config+test interpretation, and bounded verification that needs a durable conclusion but not frontier judgment.`,
    `Before doing multiple broad rg/sed/cat reads in the leader context, reuse a compatible existing explorer lane with send_input; if no useful lane exists, launch one bounded explorer subagent when that lookup can be isolated. Native explorer spawns must set agent_type=explorer and one of these allowed models: ${explorerModelListText()}. Do not inherit a frontier model for read-only lookup.`,
    `Spark is not banned from complex workflows; it should be used there as a scout/anchor collector with a tight stop condition and output cap. If a Spark child starts needing compaction or broad synthesis, it should stop and return anchors plus an escalation recommendation to the leader.`,
    "Explorer prompts must be self-contained: exact cwd, scope, read/write permission, requested evidence shape, output budget, and stop condition. Ask for file:line evidence and a short synthesis, not raw dumps.",
    "For implementation, destructive actions, architectural decisions, or final approval, the leader remains responsible; subagents gather evidence and run bounded checks only.",
    `Respect the native child-agent cap (${cap}) by reusing relevant lanes first and launching at most one new native subagent at a time unless confirmed free slots and true independence justify another.`,
  ].join(" ");
}

function buildChildNoSpawnGuidance(cap) {
  return [
    `Native child-agent boundary: this session is already a child subagent inside a parent thread with cap ${cap}.`,
    "Do not call spawn_agent from a child session. Do not recursively create critic/reviewer/verifier/researcher/explorer agents, even for broad grep-style lookup.",
    "Complete the assigned slice locally with read-only shell/tools, keep output concise with file:line evidence, and report any recommended follow-up delegation upward to the leader.",
    "If more parallel review is needed, the parent leader owns closing old agents and launching exactly one new native child per confirmed free slot.",
  ].join(" ");
}

function buildPromptGuidanceOutput(eventName, contexts) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: contexts.filter(Boolean).join(" "),
    },
  };
}

function summarize(session) {
  const agents = Object.values(session.agents ?? {}).filter((agent) => {
    return agent && typeof agent === "object" && agent.status !== "closed";
  });
  const running = agents.filter((agent) => agent.status === "running").length;
  const terminal = agents.filter((agent) => agent.status === "terminal_not_closed").length;
  const pendingSpawnReservations = spawnReservationCount(session);
  const trackedOccupied = running + terminal;
  return {
    running,
    terminal,
    pending_spawn_reservations: pendingSpawnReservations,
    tracked_occupied: trackedOccupied,
    occupied: trackedOccupied + pendingSpawnReservations,
  };
}

function applyNativeThreadEdgesToSession(session, nativeThreadEdges) {
  if (!nativeThreadEdges?.checked) return;
  for (const id of nativeThreadEdges.closed ?? []) {
    delete session.agents?.[id];
  }
}

function isoFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
}

function msFromIso(value) {
  const parsed = Date.parse(safeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeSummary(sessionSummary, transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs = 0) {
  const nativeClosed = new Set(nativeThreadEdges?.closed ?? []);
  const nativeActive = new Set(nativeThreadEdges?.active ?? []);
  const nativeTerminal = new Set(nativeThreadEdges?.terminal ?? []);
  const nativeLanes = nativeThreadEdges?.lanes instanceof Map ? nativeThreadEdges.lanes : new Map();
  const nativeChecked = Boolean(nativeThreadEdges?.checked && !nativeThreadEdges?.failed);
  const nativeEdgeTotal = nativeClosed.size + nativeActive.size + nativeTerminal.size;
  const nativeAuthoritative = nativeChecked && (nativeEdgeTotal > 0 || resetAtMs > 0);
  const transcriptActive = new Set(transcriptPool.active ?? []);
  if (!nativeAuthoritative) {
    for (const id of childSessionIds ?? []) {
      if (!transcriptPool.closed?.has(id) && !nativeClosed.has(id)) transcriptActive.add(id);
    }
  }
  for (const id of nativeClosed) {
    transcriptActive.delete(id);
  }

  const transcriptOccupied = transcriptActive.size;
  const nativeOccupied = nativeActive.size;
  const trackedOccupied = sessionSummary.tracked_occupied ?? sessionSummary.occupied;
  const pendingSpawnReservations = sessionSummary.pending_spawn_reservations ?? 0;
  const evidenceOccupied = nativeAuthoritative ? nativeOccupied : transcriptOccupied;
  const effectiveOccupied = Math.max(trackedOccupied, evidenceOccupied) + pendingSpawnReservations;
  const lastCapHitMs = Math.max(
    transcriptPool.capHitAtMs || 0,
    msFromIso(session.last_cap_hit_at),
  );
  const lastCloseMs = Math.max(
    transcriptPool.lastCloseAtMs || 0,
    msFromIso(session.last_close_at),
  );

  return {
    ...sessionSummary,
    occupied: effectiveOccupied,
    tracked_occupied: trackedOccupied,
    transcript_occupied: transcriptOccupied,
    pending_spawn_reservations: pendingSpawnReservations,
    transcript_scanned: Boolean(transcriptPool.scanned),
    transcript_truncated: Boolean(transcriptPool.truncated),
    discovered_child_sessions: childSessionIds?.size ?? 0,
    native_edge_checked: Boolean(nativeThreadEdges?.checked),
    native_edge_authoritative: nativeAuthoritative,
    native_edge_failed: Boolean(nativeThreadEdges?.failed),
    native_edge_active: nativeActive.size,
    native_edge_closed: nativeClosed.size,
    native_edge_terminal: nativeTerminal.size,
    native_terminal_ids: [...nativeTerminal].slice(0, DEFAULT_AGENT_CAP),
    native_terminal_lanes: [...nativeTerminal]
      .slice(0, DEFAULT_AGENT_CAP)
      .map((id) => nativeLanes.get(id) ?? { id }),
    native_active_lanes: [...nativeActive]
      .slice(0, DEFAULT_AGENT_CAP)
      .map((id) => nativeLanes.get(id) ?? { id }),
    native_edge_repaired: nativeThreadEdges?.repaired ?? 0,
    failed_spawns: transcriptPool.failedSpawns ?? 0,
    failed_closes: (transcriptPool.failedCloses ?? 0) + (msFromIso(session.last_close_failed_at) > lastCloseMs ? 1 : 0),
    last_cap_hit_at: isoFromMs(lastCapHitMs),
    last_close_at: isoFromMs(lastCloseMs),
    native_pool_reset_at: isoFromMs(resetAtMs),
    cap_hit_after_last_close: lastCapHitMs > 0 && lastCapHitMs > lastCloseMs,
  };
}

function shouldBlockSpawn(eventName, name, summary, cap, isChildSession, payload = null, operations = null) {
  if (eventName !== "PreToolUse") return false;
  const ops = operations ?? agentOperations(payload ?? {}, name);
  const requestedSpawns = spawnOperationCount(ops);
  if (requestedSpawns === 0) return false;
  if (hasExplorerModelRouteViolationInOperations(ops)) return true;
  if (isChildSession) return true;
  if (summary.native_edge_failed) return true;
  if (summary.occupied + requestedSpawns > cap) return true;
  if (summary.tracked_occupied + requestedSpawns > cap) return true;
  if (
    !summary.native_edge_authoritative
    && summary.transcript_scanned
    && summary.transcript_occupied + requestedSpawns > cap
  ) {
    return true;
  }
  return Boolean(summary.cap_hit_after_last_close);
}

function shouldEmitAdvisory(eventName, name, summary, cap, operations = null) {
  const ops = operations ?? agentOperations({}, name);
  if (ops.length === 0) return false;
  if (summary.terminal > 0) return true;
  if ((summary.native_edge_terminal ?? 0) > 0) return true;
  if (hasExplorerContractAdvisoryInOperations(ops)) return true;
  const threshold = Math.max(1, cap - warnRemaining());
  return summary.occupied >= threshold && (eventName === "PreToolUse" || eventName === "PostToolUse");
}

function buildAdvisory(eventName, summary, cap, blockSpawn, isChildSession, payload = null, operations = null) {
  const ops = operations ?? agentOperations(payload ?? {}, "");
  const explorerModelRouteViolation = hasExplorerModelRouteViolationInOperations(ops);
  const preferredExplorerContractAdvisory = hasPreferredExplorerContractAdvisoryInOperations(ops);
  const fallbackExplorerContractAdvisory = hasFallbackExplorerContractAdvisoryInOperations(ops);
  const requestedSpawns = spawnOperationCount(ops);
  const parts = [
    `${blockSpawn ? "Native agent pool guard" : "Native agent pool advisory"}: ${summary.occupied}/${cap} estimated slots occupied`,
    `requested_spawns=${requestedSpawns}`,
    `ledger=${summary.tracked_occupied}`,
    `transcript_fallback=${summary.transcript_occupied}`,
    `native_current=${nativeEdgeSummary(summary)}`,
    `reserved_spawns=${summary.pending_spawn_reservations}`,
    `running=${summary.running}`,
    `completed_not_closed=${summary.terminal}`,
    `failed_closes=${summary.failed_closes}`,
    `cap_hit_after_last_close=${summary.cap_hit_after_last_close ? "yes" : "no"}`,
  ];

  const context = [
    parts.join(", ") + ".",
    explorerModelRouteViolation
      ? `Explorer native spawn is blocked until tool input explicitly sets an allowed explorer model (${explorerModelListText()}). Use ${explorerModel()} for fast scout/probe work and ${explorerFallbackModel()} for reasoning explorer or light executor work. Do not inherit a frontier model for read-only lookup.`
      : null,
    preferredExplorerContractAdvisory
      ? `Explorer route advisory, not a block: ${explorerModel()} is useful even inside complex work when the output contract is scout/anchor collection. Keep the prompt bounded with exact scope, file:line evidence, output cap, and stop condition; if the child must synthesize a durable verdict, edit files, approve a claim, or repeatedly compact, route that follow-up to ${explorerFallbackModel()} or a frontier reviewer.`
      : null,
    fallbackExplorerContractAdvisory
      ? `Explorer route advisory, not a block: this looks like a narrow scan that ${explorerModel()} can usually handle faster. ${explorerFallbackModel()} remains valid when you want more synthesis, resilience, or light execution, but do not spend the reasoning lane on disposable grep unless the context lane is already useful.`
      : null,
    blockSpawn && isChildSession
      ? "Nested native spawn is blocked: child sessions must not create subagents. Finish the assigned slice locally and report any needed follow-up delegation to the parent leader."
      : null,
	    blockSpawn
	      ? (explorerModelRouteViolation
	          ? "Retry at most one explorer spawn after correcting the explicit model route, and only if remaining_spawn_budget is still positive."
	          : isChildSession
	          ? "Do not restate or retry the nested spawn prompt. Continue the child task locally; the parent leader decides any follow-up delegation."
	          : (summary.cap_hit_after_last_close
	              ? "This thread already saw a native pool-exhaustion failure after the last confirmed close; do not retry spawn_agent until a later close succeeds."
	              : "This spawn is likely to fail or race another pending spawn reservation; do not restate the long spawn prompt in commentary. First reuse a compatible completed lane with send_input, wait for active agents, or close a no-longer-needed lane, then retry only one spawn per confirmed free slot."))
	      : "Completed subagents are reusable context lanes and still consume native slots until closed; pending spawn reservations also count until the spawn succeeds, fails, or expires.",
    summary.failed_closes > 0
      ? "At least one recent close was not confirmed; treat capacity as uncertain and serialize follow-up spawns."
      : null,
    summary.native_edge_failed
      ? "Native thread_spawn_edges could not be read; spawn capacity is unknown, so serialize and retry only after the state read succeeds."
      : null,
	    "This hook does not choose which agent to reuse/close or whether delegation is needed; it only surfaces native pool pressure and enforces the no-recursive-spawn boundary.",
  ].filter(Boolean).join(" ");

  if (blockSpawn) {
    return {
      decision: "block",
      reason: context,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function buildLockUnavailableAdvisory(eventName, cap, isChildSession, operations) {
  const hasSpawn = hasSpawnOperation(operations);
  const context = [
    "Native agent pool guard: advisor state lock is unavailable, so current capacity cannot be reconciled.",
    hasSpawn
      ? `Blocking spawn_agent conservatively. The native cap is ${cap}; retry one spawn only after the lock clears or continue locally.`
      : "Serialize agent-pool operations until the lock clears.",
    isChildSession
      ? "This is a child session; nested native spawn remains disallowed."
      : null,
  ].filter(Boolean).join(" ");
  if (eventName === "PreToolUse" && hasSpawn) {
    return {
      decision: "block",
      reason: context,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function applyTranscriptEvidenceToSession(session, transcriptPool) {
  if (transcriptPool.scanned && !transcriptPool.truncated) {
    session.last_cap_hit_at = isoFromMs(Math.max(
      transcriptPool.capHitAtMs,
      msFromIso(session.last_cap_hit_at),
    ));
    session.last_close_at = isoFromMs(Math.max(
      transcriptPool.lastCloseAtMs,
      msFromIso(session.last_close_at),
    ));
    return;
  }
  if (transcriptPool.capHitAtMs > msFromIso(session.last_cap_hit_at)) {
    session.last_cap_hit_at = isoFromMs(transcriptPool.capHitAtMs);
  }
  if (transcriptPool.lastCloseAtMs > msFromIso(session.last_close_at)) {
    session.last_close_at = isoFromMs(transcriptPool.lastCloseAtMs);
  }
}

async function main() {
  try {
    const payload = await readStdinJson();
    const eventName = hookEventName(payload);
    const name = toolName(payload);
    if (!eventName) return;
    await loadRuntimeOptions();
    const operations = agentOperations(payload, name);
    if (safeString(process.env.NATIVE_AGENT_POOL_ADVISOR_DEBUG).trim() === "1") {
      await appendAdvisorLog({
        event: "debug_operations",
        hook_event_name: eventName,
        tool_name: name,
        operations,
      });
    }
    if (isToolHookEvent(eventName) && operations.length === 0) return;

    const cap = await readAgentCap();
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const identity = await sessionIdentity(payload);

    const lockResult = await withStateLock(async () => {
      const state = await readState();
      await maintainNativePoolStorage(state, nowMs, nowIso);
      pruneAdvisorSessions(state, nowMs);
      const session = normalizeSession(state, identity.key);
      pruneStaleRunningAgents(session, nowMs);
      pruneSpawnReservations(session, nowMs);

      const prompt = promptText(payload);
      if (eventName === "SessionStart" || eventName === "UserPromptSubmit") {
        if (eventName === "SessionStart" && !isManagedBridgeInvocation()) return;
        let promptSummary = null;
        if (eventName === "UserPromptSubmit") {
          const resetAtMs = nativePoolResetMs(state, identity.poolThreadId || identity.threadId);
          const { transcriptPool, childSessionIds, nativeThreadEdges } = await collectPoolEvidence(identity, nowMs, resetAtMs);
          applyTranscriptEvidenceToSession(session, transcriptPool);
          applyNativeThreadEdgesToSession(session, nativeThreadEdges);
          promptSummary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs);
        }
        const emitCapacity = shouldEmitCapacityGuidance(eventName, prompt, session, nowMs, identity.isChildSession, promptSummary, cap);
        const emitDelegation = shouldEmitDelegationGuidance(eventName, prompt, session, nowMs, identity.isChildSession);
        const emitChildNoSpawn = shouldEmitChildNoSpawnGuidance(eventName, prompt, session, nowMs, identity.isChildSession);
        if (emitCapacity) markCapacityGuidanceEmitted(eventName, prompt, session, nowIso);
        if (emitDelegation) markDelegationGuidanceEmitted(prompt, session, nowIso);
        if (emitChildNoSpawn) markChildNoSpawnGuidanceEmitted(prompt, session, nowIso);
        session.updated_at = nowIso;
        state.updated_at = nowIso;
        await writeState(state);
        if (emitCapacity || emitDelegation || emitChildNoSpawn) {
          const contexts = [
            emitCapacity ? buildCapacityGuidance(eventName, cap, promptSummary) : "",
            emitDelegation ? buildDelegationGuidance(cap) : "",
            emitChildNoSpawn ? buildChildNoSpawnGuidance(cap) : "",
          ];
          process.stdout.write(`${JSON.stringify(buildPromptGuidanceOutput(eventName, contexts))}\n`);
        }
        return;
      }

      if (operations.length === 0) return;

      const resetAtMs = nativePoolResetMs(state, identity.poolThreadId || identity.threadId);
      const { transcriptPool, childSessionIds, nativeThreadEdges } = await collectPoolEvidence(identity, nowMs, resetAtMs);
      applyNativeThreadEdgesToSession(session, nativeThreadEdges);

      const isPreSpawn = eventName === "PreToolUse" && hasSpawnOperation(operations);
      let summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs);
      let blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);

      if (isPreSpawn && !blockSpawn) {
        reserveSpawnSlot(session, payload, nowMs, nowIso, spawnOperationCount(operations));
        summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs);
      }

      if (eventName === "PostToolUse") {
        let clearedSpawnReservation = false;
        for (const operation of operations) {
          const operationPayload = payloadForOperation(payload, operation);
          if (operation.name === "spawn_agent") {
            if (!clearedSpawnReservation) {
              clearSpawnReservation(session, payload);
              clearedSpawnReservation = true;
            }
            markSpawned(session, operationPayload, nowIso);
            for (const id of collectSpawnedAgentIds(operationPayload)) transcriptPool.active.add(id);
            if (textLooksSpawnCapacityFailure(responseText(operationPayload))) {
              session.last_cap_hit_at = nowIso;
            }
            continue;
          }
          if (operation.name === "wait_agent") {
            markWaited(session, operationPayload, nowIso);
            continue;
          }
          if (operation.name !== "close_agent") continue;

          const closedIds = markClosed(session, operationPayload);
          if (closedIds.length > 0) {
            const changedNativeRows = await repairClosedNativeEdges(identity.poolThreadId, closedIds);
            for (const id of closedIds) {
              const wasNativeOpen = nativeThreadEdges.active?.has(id) || nativeThreadEdges.terminal?.has(id);
              if (changedNativeRows > 0 || !wasNativeOpen) {
                nativeThreadEdges.active?.delete(id);
                nativeThreadEdges.terminal?.delete(id);
                nativeThreadEdges.closed?.add(id);
              } else {
                await appendAdvisorLog({
                  event: "native_edge_close_repair_missed",
                  parent_thread_id: identity.poolThreadId,
                  child_thread_id: id,
                });
              }
            }
            session.last_close_at = nowIso;
            for (const id of closedIds) transcriptPool.active.delete(id);
          } else if (closeLooksFailed(operationPayload)) {
            session.last_close_failed_at = nowIso;
          }
        }
        summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs);
        blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);
      }

      applyTranscriptEvidenceToSession(session, transcriptPool);

      session.updated_at = nowIso;
      state.updated_at = nowIso;
      await writeState(state);

      summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs);
      if (!isPreSpawn) blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);
      if (blockSpawn || shouldEmitAdvisory(eventName, name, summary, cap, operations)) {
        process.stdout.write(`${JSON.stringify(buildAdvisory(eventName, summary, cap, blockSpawn, identity.isChildSession, payload, operations))}\n`);
      }
    });
    if (lockResult === LOCK_UNAVAILABLE && isToolHookEvent(eventName) && operations.length > 0) {
      process.stdout.write(`${JSON.stringify(buildLockUnavailableAdvisory(eventName, cap, identity.isChildSession, operations))}\n`);
    }
  } catch (error) {
    try {
      const path = join(codexHome(), "log", `${COMMAND_NAME}.log`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`, {
        flag: "a",
      });
    } catch {
      // Never let this advisory hook affect Codex tool execution.
    }
  }
}

main();

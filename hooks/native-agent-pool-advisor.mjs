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
const DEFAULT_EXPLORER_FORBIDDEN_MODELS = ["gpt-5.5"];
const execFileAsync = promisify(execFile);
const LOCK_UNAVAILABLE = Symbol("native-agent-pool-advisor-lock-unavailable");
let runtimeOptionsCache = {
  defaultAgentCap: DEFAULT_AGENT_CAP,
  warnRemaining: DEFAULT_WARN_REMAINING,
  stateDbName: DEFAULT_STATE_DB_NAME,
  stateDbPathOverride: "",
  explorerPreferredModel: DEFAULT_EXPLORER_MODEL,
  explorerFallbackModel: DEFAULT_EXPLORER_FALLBACK_MODEL,
  explorerForbiddenModels: [...DEFAULT_EXPLORER_FORBIDDEN_MODELS],
};

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function compactOneLine(value, maxLength = 96) {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function slotCap(cap = DEFAULT_AGENT_CAP) {
  const parsed = Number(cap);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_AGENT_CAP;
}

function clampSlotCount(value, cap = DEFAULT_AGENT_CAP) {
  const parsed = Number(value);
  const count = Number.isFinite(parsed) ? Math.floor(parsed) : 0;
  return Math.max(0, Math.min(slotCap(cap), count));
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
  const forbiddenExplorerModels = parseStringList(
    process.env.NATIVE_AGENT_POOL_EXPLORER_FORBIDDEN_MODELS
      ?? models.explorer_forbidden
      ?? models.explorerForbidden
      ?? models.forbiddenExplorer
      ?? models.forbidden_explorer
      ?? DEFAULT_EXPLORER_FORBIDDEN_MODELS,
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
    explorerForbiddenModels: forbiddenExplorerModels.length > 0
      ? forbiddenExplorerModels
      : [...DEFAULT_EXPLORER_FORBIDDEN_MODELS],
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

function explorerForbiddenModels() {
  const configured = Array.isArray(runtimeOptionsCache.explorerForbiddenModels)
    ? runtimeOptionsCache.explorerForbiddenModels
    : [];
  const models = configured.map((model) => safeString(model).trim()).filter(Boolean);
  return models.length > 0 ? models : [...DEFAULT_EXPLORER_FORBIDDEN_MODELS];
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
  const byName = new Map();
  for (const operation of operations) {
    const index = byName.get(operation.name) ?? 0;
    operation.name_index = index;
    byName.set(operation.name, index + 1);
  }
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
  const unscoped = !poolThreadId;
  return {
    threadId,
    parentThreadId,
    poolThreadId,
    transcript,
    key: poolThreadId ? `thread:${poolThreadId}` : `unscoped:${hashText(JSON.stringify({
      event: hookEventName(payload),
      tool: toolName(payload),
      transcript,
      prompt: promptText(payload),
    }))}`,
    isChildSession: Boolean(parentThreadId) || directChildSessionFlag(payload),
    unscoped,
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
    missingClosed: new Set(),
    slotOccupied: 0,
    slotEstimateEvents: 0,
    slotEstimateReliable: false,
    slotEstimateSawCapHit: false,
    failedSpawns: 0,
    failedCloses: 0,
    capHitAtMs: 0,
    lastCloseAtMs: 0,
    scanned: false,
    truncated: false,
  };
}

function parseTranscriptPool(text, parentThreadId = "", sinceMs = 0, cap = DEFAULT_AGENT_CAP) {
  const pool = emptyTranscriptPool();
  if (!text.trim()) return pool;
  pool.scanned = true;
  pool.truncated = !text.startsWith("{");
  const capValue = slotCap(cap);
  let slotEstimate = 0;
  let slotEstimateKnown = !pool.truncated;
  let slotEstimateSawCapHit = false;
  let slotEstimateEvents = 0;
  const pendingSpawnCalls = new Map();
  const pendingCloseCalls = new Map();
  const noteSlotSpawn = (count = 1) => {
    const amount = Math.max(1, Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 1);
    if (!slotEstimateKnown) slotEstimate = 0;
    slotEstimate = clampSlotCount(slotEstimate + amount, capValue);
    slotEstimateKnown = true;
    slotEstimateEvents += amount;
  };
  const noteSlotCapHit = () => {
    slotEstimate = capValue;
    slotEstimateKnown = true;
    slotEstimateSawCapHit = true;
    slotEstimateEvents += 1;
  };
  const noteSlotClose = (count = 1) => {
    const amount = Math.max(1, Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 1);
    if (slotEstimateKnown) {
      slotEstimate = clampSlotCount(slotEstimate - amount, capValue);
    }
    slotEstimateEvents += amount;
  };

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
        noteSlotSpawn(1);
      } else {
        pool.failedSpawns += 1;
        if (textLooksSpawnCapacityFailure(JSON.stringify(payload ?? ""))) {
          pool.capHitAtMs = Math.max(pool.capHitAtMs, eventTimestampMs(record));
          noteSlotCapHit();
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
          noteSlotSpawn(spawnedIds.length);
        } else {
          pool.failedSpawns += 1;
          if (textLooksSpawnCapacityFailure(safeString(output))) {
            pool.capHitAtMs = Math.max(pool.capHitAtMs, eventTimestampMs(record));
            noteSlotCapHit();
          }
        }
        continue;
      }
      const closeIds = callId ? pendingCloseCalls.get(callId) : null;
      if (closeIds) {
        pendingCloseCalls.delete(callId);
        const outputText = safeString(payload.output ?? payload.result ?? "");
        if (textLooksCloseTargetMissing(outputText)) {
          for (const id of closeIds) {
            pool.missingClosed.add(id);
          }
          const activeCloseIds = closeIds.filter((id) => pool.active.has(id));
          for (const id of activeCloseIds) {
            pool.closed.add(id);
            pool.active.delete(id);
            pool.lastCloseAtMs = Math.max(pool.lastCloseAtMs, eventTimestampMs(record));
          }
          if (activeCloseIds.length > 0) noteSlotClose(activeCloseIds.length);
          continue;
        }
        if (textLooksCloseFailed(outputText)) {
          pool.failedCloses += closeIds.length;
          continue;
        }
        for (const id of closeIds) {
          pool.closed.add(id);
          pool.active.delete(id);
          pool.lastCloseAtMs = Math.max(pool.lastCloseAtMs, eventTimestampMs(record));
        }
        noteSlotClose(closeIds.length);
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
    noteSlotClose(closeIds.length);
  }

  pool.slotOccupied = clampSlotCount(slotEstimate, capValue);
  pool.slotEstimateEvents = slotEstimateEvents;
  pool.slotEstimateSawCapHit = slotEstimateSawCapHit;
  pool.slotEstimateReliable = Boolean(slotEstimateEvents > 0 && (slotEstimateSawCapHit || !pool.truncated));
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
      if (textHasTaskCompleteEvent(buffer.subarray(0, bytesRead).toString("utf-8"))) return true;
      if (start === 0) return false;
      return await scanTranscriptForTaskComplete(path, stats.size);
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

function textHasTaskCompleteEvent(text) {
  for (const line of safeString(text).split(/\r?\n/)) {
    if (!line.includes('"task_complete"')) continue;
    const record = parseJsonLine(line);
    const payload = safeObject(record?.payload);
    if (record?.type === "event_msg" && payload?.type === "task_complete") {
      return true;
    }
  }
  return false;
}

async function scanTranscriptForTaskComplete(path, size) {
  let handle;
  try {
    handle = await open(path, "r");
    const chunkSize = 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    let carry = "";
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkSize, size - offset), offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf-8");
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      if (textHasTaskCompleteEvent(lines.join("\n"))) return true;
    }
    return textHasTaskCompleteEvent(carry);
  } catch {
    return false;
  } finally {
    try {
      await handle?.close();
    } catch {
      // best effort
    }
  }
}

async function repairClosedNativeEdgeIds(parentThreadId, closedIds) {
  const ids = [...(closedIds ?? [])].filter(Boolean).slice(0, NATIVE_EDGE_REPAIR_BATCH);
  const parentId = safeString(parentThreadId).trim();
  if (ids.length === 0 || !parentId) return new Set();
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return new Set();

  const selectSql = [
    "select child_thread_id",
    "from thread_spawn_edges",
    "where status!='closed'",
    `and parent_thread_id=${sqlString(parentId)}`,
    `and child_thread_id in (${ids.map(sqlString).join(",")});`,
  ].join(" ");
  const sql = [
    "pragma busy_timeout=250;",
    "update thread_spawn_edges",
    "set status='closed'",
    "where status!='closed'",
    `and parent_thread_id=${sqlString(parentId)}`,
    `and child_thread_id in (${ids.map(sqlString).join(",")});`,
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout: selectStdout } = await execFileAsync("sqlite3", ["-json", dbPath, selectSql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const repairableRows = parseSqliteJsonOutput(selectStdout);
    const repairableIds = new Set(
      (Array.isArray(repairableRows) ? repairableRows : [])
        .map((row) => safeString(row?.child_thread_id).trim())
        .filter(Boolean),
    );
    if (repairableIds.size === 0) return repairableIds;

    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    const changed = Number(rows?.[0]?.changed ?? 0);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_edge_close_repair",
        parent_thread_id: parentId,
        requested: ids.length,
        changed,
      });
    }
    return changed > 0 ? repairableIds : new Set();
  } catch {
    return new Set();
  }
}

async function repairUniqueMissingNativeEdgeIds(closedIds) {
  const ids = [...(closedIds ?? [])].filter(Boolean).slice(0, NATIVE_EDGE_REPAIR_BATCH);
  if (ids.length === 0) return new Map();
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return new Map();

  const selectSql = [
    "select parent_thread_id,child_thread_id",
    "from thread_spawn_edges",
    "where status!='closed'",
    `and child_thread_id in (${ids.map(sqlString).join(",")})`,
    "order by child_thread_id,parent_thread_id;",
  ].join(" ");

  try {
    const { stdout: selectStdout } = await execFileAsync("sqlite3", ["-json", dbPath, selectSql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(selectStdout);
    const parentsByChild = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const childId = safeString(row?.child_thread_id).trim();
      const parentId = safeString(row?.parent_thread_id).trim();
      if (!childId || !parentId) continue;
      if (!parentsByChild.has(childId)) parentsByChild.set(childId, new Set());
      parentsByChild.get(childId).add(parentId);
    }

    const uniquePairs = [];
    for (const [childId, parentIds] of parentsByChild.entries()) {
      if (parentIds.size !== 1) continue;
      uniquePairs.push([childId, [...parentIds][0]]);
    }
    if (uniquePairs.length === 0) return new Map();

    const conditions = uniquePairs
      .map(([childId, parentId]) => `(parent_thread_id=${sqlString(parentId)} and child_thread_id=${sqlString(childId)})`)
      .join(" or ");
    const sql = [
      "pragma busy_timeout=250;",
      "update thread_spawn_edges",
      "set status='closed'",
      "where status!='closed'",
      `and (${conditions});`,
      "select changes() as changed;",
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = Number(parseSqliteJsonOutput(stdout)?.[0]?.changed ?? 0);
    if (changed <= 0) return new Map();

    const repaired = new Map(uniquePairs);
    await appendAdvisorLog({
      event: "native_edge_close_not_found_unique_child_repair",
      requested: ids.length,
      changed,
      repaired: [...repaired.entries()].map(([child_thread_id, parent_thread_id]) => ({
        child_thread_id,
        parent_thread_id,
      })),
    });
    return repaired;
  } catch {
    return new Map();
  }
}

async function repairClosedNativeEdges(parentThreadId, closedIds) {
  return (await repairClosedNativeEdgeIds(parentThreadId, closedIds)).size;
}

async function applyMissingCloseEvidence(parentThreadId, transcriptPool, nativeThreadEdges) {
  const ids = [...(transcriptPool?.missingClosed ?? [])].filter(Boolean).slice(0, NATIVE_EDGE_REPAIR_BATCH);
  const parentId = safeString(parentThreadId).trim();
  if (!parentId || ids.length === 0) return 0;

  const repairedIds = await repairClosedNativeEdgeIds(parentId, ids);
  const nativeAuthoritative = Boolean(nativeThreadEdges?.checked && !nativeThreadEdges?.failed);
  const effectiveIds = nativeAuthoritative ? repairedIds : new Set(ids);
  for (const id of effectiveIds) {
    nativeThreadEdges?.active?.delete(id);
    nativeThreadEdges?.terminal?.delete(id);
    nativeThreadEdges?.closed?.add(id);
  }
  if (repairedIds.size > 0) {
    await appendAdvisorLog({
      event: "native_edge_close_not_found_repair",
      parent_thread_id: parentId,
      requested: ids.length,
      changed: repairedIds.size,
    });
  }
  return repairedIds.size;
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
  if (!existsSync(dbPath)) {
    edges.checked = true;
    edges.failed = true;
    return edges;
  }

  const sql = [
    "select e.child_thread_id,e.status,t.rollout_path,t.title,t.agent_role,t.model,t.reasoning_effort,t.agent_nickname,t.cwd,t.updated_at",
    "from thread_spawn_edges e",
    "left join threads t on t.id=e.child_thread_id",
    `where e.parent_thread_id=${sqlString(parentThreadId)}`,
    "order by coalesce(t.updated_at,0) desc",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    if (!Array.isArray(rows)) return edges;

    edges.checked = true;
    const terminalRepairCandidates = [];
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
          terminalRepairCandidates.push(childId);
        } else {
          edges.active.add(childId);
        }
      }
    }
    if (terminalRepairCandidates.length > 0) {
      const repairedIds = await repairClosedNativeEdgeIds(parentThreadId, terminalRepairCandidates);
      edges.repaired = repairedIds.size;
      for (const childId of terminalRepairCandidates) {
        if (repairedIds.has(childId)) {
          edges.closed.add(childId);
        } else {
          edges.terminal.add(childId);
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

async function collectPoolEvidence(identity, nowMs, resetAtMs = 0, cap = DEFAULT_AGENT_CAP) {
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
    cap,
  );
  const [childSessionIds, nativeThreadEdges] = await Promise.all([
    discoverRecentChildSessionIds(poolThreadId, nowMs, resetAtMs),
    discoverNativeThreadEdges(poolThreadId),
  ]);
  await applyMissingCloseEvidence(poolThreadId, transcriptPool, nativeThreadEdges);
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

function operationModel(operation) {
  return safeString(operation?.input?.model).trim();
}

function normalizeAgentRole(value) {
  return safeString(value).trim().toLowerCase().replace(/^functions\./, "");
}

function operationAgentRole(operation) {
  return normalizeAgentRole(
    operation?.input?.agent_type
      ?? operation?.input?.agentType
      ?? operation?.input?.role
      ?? operation?.input?.type,
  );
}

function operationForkContext(operation) {
  const value = operation?.input?.fork_context ?? operation?.input?.forkContext;
  return value === true;
}

function hasSpawnOperation(operations) {
  return operations.some((operation) => operation.name === "spawn_agent");
}

function spawnOperationCount(operations) {
  return operations.filter((operation) => operation.name === "spawn_agent").length;
}

function hasForkContextModelConflictInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    return operationForkContext(operation) && Boolean(operationModel(operation));
  });
}

function hasForkContextModelInheritanceInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    return operationForkContext(operation) && !operationModel(operation);
  });
}

function hasMissingSpawnModelInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (operationForkContext(operation)) return false;
    return !operationModel(operation);
  });
}

function explorerForbiddenModelViolations(operations) {
  const forbidden = new Set(explorerForbiddenModels().map((model) => model.toLowerCase()));
  return operations.filter((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (operationForkContext(operation)) return false;
    const role = operationAgentRole(operation);
    if (role !== "explorer" && role !== "explore") return false;
    const model = operationModel(operation).toLowerCase();
    return Boolean(model && forbidden.has(model));
  });
}

function hasExplorerForbiddenModelInOperations(operations) {
  return explorerForbiddenModelViolations(operations).length > 0;
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
    const matches = response.filter((item) => operationResponseItemMatches(item, operation));
    const matched = matches[operation?.name_index ?? 0] ?? matches[0];
    return matched ? unwrapOperationResponseItem(matched) : response;
  }
  if (response && typeof response === "object") {
    if (operationResponseItemMatches(response, operation)) {
      return unwrapOperationResponseItem(response);
    }
    for (const key of ["tool_uses", "toolUses", "results", "responses", "outputs"]) {
      if (Array.isArray(response[key])) {
        const matches = response[key].filter((item) => operationResponseItemMatches(item, operation));
        const matched = matches[operation?.name_index ?? 0] ?? matches[0];
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

function textLooksCloseTargetMissing(text) {
  return /(?:unknown agent|agent (?:with id [A-Za-z0-9_.:-]+ )?not found|no such agent|invalid agent(?: id)?|agent [A-Za-z0-9_.:-]+ not found|(?:agent|代理|智能体)[^.!?\n]{0,80}(?:不存在|未找到))/i.test(
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

function closeLooksTargetMissing(payload) {
  return textLooksCloseTargetMissing(responseText(payload));
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

function looksLikeSpawnIntentPrompt(prompt) {
  const normalized = safeString(prompt).toLowerCase();
  return /(?:\bspawn_agent\b|\bnative\s+(?:sub)?agents?\b|\bsubagents?\b|\bchild\s+agents?\b|\bagents?\b|\bexplorers?\b|\breviewers?\b|\bverifiers?\b|\bresearchers?\b|\bcritics?\b|\bparallel\b|\bfan[ -]?out\b|子代理|智能体|代理|explorer|并行|派发|审查代理|验证代理|评审代理|复审代理|调查代理|研究代理)/i.test(normalized);
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
        || summary.cap_hit_blocks_spawn
        || summary.failed_closes > 0
        || summary.pending_spawn_reservations > 0
      ),
  );
}

function shouldEmitCapacityGuidance(eventName, prompt, session, nowMs, isChildSession, promptSummary = null, cap = DEFAULT_AGENT_CAP) {
  if (isChildSession) return false;
  if (eventName === "SessionStart") {
    const criticalPressure = Boolean(
      promptSummary
        && (
          remainingSpawnBudget(promptSummary, cap) <= warnRemaining()
          || promptSummary.cap_hit_blocks_spawn
          || promptSummary.failed_closes > 0
          || promptSummary.pending_spawn_reservations > 0
          || (promptSummary.native_edge_overflow ?? 0) > 0
        ),
    );
    if (criticalPressure) return true;
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
        || promptSummary.cap_hit_blocks_spawn
        || (promptSummary.native_edge_overflow ?? 0) > 0
      ),
  );
  if (criticalPressure) return true;
  if (looksLikeSpawnIntentPrompt(prompt)) return true;

  const signature = hashText(prompt.trim().toLowerCase());
  const last = msFromIso(session.last_capacity_prompt_guidance_at);
  if (last && nowMs - last < PROMPT_CAPACITY_GUIDANCE_TTL_MS) return false;
  if (session.last_capacity_prompt_signature === signature && last) return false;
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

function remainingSpawnBudget(summary, cap) {
  if (!summary) return cap;
  if (summary.cap_hit_blocks_spawn) return 0;
  return Math.max(0, cap - (summary.occupied ?? 0));
}

function capacityGuaranteeLevel(summary) {
  if (!summary) return "unavailable";
  if (summary.native_edge_failed) return "unavailable";
  if (summary.native_edge_authoritative) return "observed_native_snapshot";
  if (summary.transcript_slot_reliable) return "observed_transcript_snapshot";
  if (summary.transcript_scanned) return "fallback_transcript_snapshot";
  return "fallback_ledger_snapshot";
}

function capacitySnapshot(summary, cap, requestedSpawns = 0) {
  const capValue = slotCap(cap);
  const requested = Math.max(0, Math.floor(Number(requestedSpawns) || 0));
  const observedUsed = summary?.cap_hit_blocks_spawn
    ? capValue
    : clampSlotCount(summary?.occupied ?? 0, capValue);
  const observedFree = summary?.cap_hit_blocks_spawn ? 0 : Math.max(0, capValue - observedUsed);
  return {
    total_cap: capValue,
    observed_used: observedUsed,
    observed_free: observedFree,
    remaining_spawn_budget: observedFree,
    requested_spawns: requested,
    close_needed_for_request: Math.max(0, requested - observedFree),
    close_needed_for_one: observedFree > 0 ? 0 : 1,
    runtime_reservation: false,
    batch_guarantee: false,
    guarantee_level: capacityGuaranteeLevel(summary),
    recommended_protocol: requested > 1 ? "single_spawn_then_resample" : "single_spawn_or_reuse_then_resample",
  };
}

function formatCapacitySnapshot(snapshot) {
  return [
    `total_cap=${snapshot.total_cap}`,
    `observed_used=${snapshot.observed_used}`,
    `observed_free=${snapshot.observed_free}`,
    `remaining_spawn_budget=${snapshot.remaining_spawn_budget}`,
    `requested_spawns=${snapshot.requested_spawns}`,
    `close_needed_for_request=${snapshot.close_needed_for_request}`,
    `close_needed_for_one=${snapshot.close_needed_for_one}`,
    `guarantee_level=${snapshot.guarantee_level}`,
    `runtime_reservation=${snapshot.runtime_reservation ? "true" : "false"}`,
    `batch_guarantee=${snapshot.batch_guarantee ? "true" : "false"}`,
    `recommended_protocol=${snapshot.recommended_protocol}`,
  ].join(", ");
}

function nativeEdgeSummary(summary) {
  if (summary?.native_edge_failed) return "unavailable";
  if (summary?.native_edge_checked) {
    const authority = summary.native_edge_authoritative ? "authoritative" : "fallback";
    return `slot_open=${summary.native_edge_active ?? 0}, slot_terminal=${summary.native_edge_terminal ?? 0}, slot_estimate=${summary.native_edge_slot_occupied ?? summary.occupied}/${summary.native_edge_cap ?? "?"}, ledger_lag=${summary.native_edge_ledger_lag ?? 0}, db_open_edge_debt=${summary.native_edge_debt ?? 0}, open_edge_overflow=${summary.native_edge_overflow ?? 0}, authority=${authority}`;
  }
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
  const activeLanes = Array.isArray(summary?.native_active_lanes) ? summary.native_active_lanes : [];
  const lanes = Array.isArray(summary?.native_terminal_lanes) ? summary.native_terminal_lanes : [];
  if (activeLanes.length === 0 && lanes.length === 0) return "";
  const activeText = activeLanes.length > 0
    ? `Current-parent open native lanes without task_complete evidence: ${activeLanes.map(formatTerminalLaneSummary).join(" | ")}.`
    : "";
  const terminalText = lanes.length > 0
    ? `Current-parent completed-not-closed native edge candidates: ${lanes.map(formatTerminalLaneSummary).join(" | ")}.`
    : "";
  const overflowText = (summary?.native_edge_overflow ?? 0) > 0
    ? `Native DB open-edge debt exceeds the ${summary.native_edge_cap ?? "configured"}-slot runtime cap: db_open_edge_debt=${summary.native_edge_debt}, open_edge_overflow=${summary.native_edge_overflow}. Overflow rows are repair debt, not additional live agents.`
    : "";
  const reuseText = "LANE_REUSE_CHECK_REQUIRED=true. Before any new spawn, compare the intended task contract against the current-parent lane inventory above. If a same-topic/same-domain lane has compatible model and context, use send_input to reuse that lane instead of spawning. Close a lane only when it is no longer useful, has the wrong role/model for the next task, or a slot must be freed for higher-value work.";
  return `${activeText} ${terminalText} ${reuseText} ${overflowText} Runtime occupied slots are capped by the native pool. These rows affect only this parent/session; rows from other parent sessions are diagnostic reset debt, not admission evidence here. Only a successful close_agent result or runtime not-found close evidence decrements the slot estimate for a current-parent lane. Other close_agent failures do not free capacity.`.trim();
}

function zeroBudgetRecoveryGuidance(summary) {
  const activeLanes = Array.isArray(summary?.native_active_lanes) ? summary.native_active_lanes : [];
  const terminalLanes = Array.isArray(summary?.native_terminal_lanes) ? summary.native_terminal_lanes : [];
  const hasListedLane = activeLanes.length > 0 || terminalLanes.length > 0;
  const candidateText = terminalLanes.length > 0
    ? "Prefer completed-not-closed candidates first."
    : activeLanes.length > 0
    ? "Only close an active lane when the leader knows it is no longer needed; otherwise reuse it, wait for it, or continue locally."
    : "No current-parent close target is listed; treat this as a state mismatch and verify hook/native DB state instead of retrying spawn.";
  return [
    "ZERO_BUDGET_RECOVERY_REQUIRED=true.",
    "Do not stop at saying the subagent pool is full.",
    "Before any new spawn, choose one recovery action: reuse a compatible current-parent lane with send_input, close listed current-parent lane(s) that are no longer needed, wait for an active lane if its result is needed, or continue locally.",
    candidateText,
    hasListedLane
      ? "After a successful close_agent or runtime not-found close repair, re-check capacity and use the refreshed observed_free snapshot; without runtime reservation, launch at most one child before sampling again."
      : "If live state says fewer lanes exist than the hook snapshot, run a fresh hook/live check and use the newer scoped budget."
  ].join(" ");
}

function buildTurnBudgetGuidance(summary, cap) {
  if (!summary) return "";
  const snapshot = capacitySnapshot(summary, cap, 0);
  const hardDirective = snapshot.observed_free === 0
    ? "SPAWN_AGENT_DISABLED_THIS_TURN=true (zero-budget observed snapshot). observed_free=0, remaining_spawn_budget=0: do not call spawn_agent from this capacity snapshot. First reuse or close known no-longer-needed current-parent lane(s), or continue locally. After close_agent succeeds or runtime not-found close evidence appears, rely on the next hook/PreToolUse capacity check before spawning; do not keep treating this stale zero-budget message as current state."
    : `SPAWN_AGENT_OBSERVED_FREE=${snapshot.observed_free}. BATCH_SPAWN_GUARANTEE=false. This is an observed snapshot, not an atomic runtime reservation; launch at most one new child, then re-check capacity before another spawn.`;
  return [
    hardDirective,
    `Current parent/session native subagent capacity snapshot: occupied=${summary.occupied}/${cap}, ${formatCapacitySnapshot(snapshot)}, slot_pressure_source=${summary.slot_pressure_source}, ledger_slot=${summary.tracked_occupied}, ledger_unresolved=${summary.tracked_unresolved}, transcript_slot=${summary.transcript_occupied}, transcript_unresolved=${summary.transcript_unresolved}, native_slots=${nativeEdgeSummary(summary)}, completed_not_closed=${summary.terminal}, reserved_spawns=${summary.pending_spawn_reservations}, cap_hit_after_last_close=${summary.cap_hit_after_last_close ? "yes" : "no"}, cap_hit_blocks_spawn=${summary.cap_hit_blocks_spawn ? "yes" : "no"}.`,
    snapshot.observed_free === 0 ? zeroBudgetRecoveryGuidance(summary) : "",
    terminalCloseTargetGuidance(summary),
    "The hook has no atomic runtime reservation API. observed_free/remaining_spawn_budget is a compatibility alias for the current observed free count, not a guaranteed batch size.",
    "wait_agent does not free a slot; close_agent frees a slot only after a successful close result or runtime not-found close evidence.",
    "When observed_free is 0, do not call spawn_agent. Continue locally, reuse a compatible lane, or close known no-longer-needed current-parent lane(s) first; send_input and wait_agent do not increase capacity. If close_agent succeeds, re-check capacity before any spawn because the older zero-budget snapshot is no longer authoritative.",
  ].filter(Boolean).join(" ");
}

function buildSubagentModelSelectionGuidance() {
  return [
    "SUBAGENT_MODEL_SELECTION_REQUIRED=true. SUBAGENT_MODEL_DECISION_REQUIRED=true.",
    "Before any spawn_agent call, decide task_contract={output,risk,state_depth,context_size,edit_permission,final_authority,output_cap,stop_condition}.",
    `Every spawn_agent call in this assistant response must include an explicit model. If there is no stronger reason, default to model="${explorerFallbackModel()}".`,
    `Use model="${explorerModel()}" only for read-only scout output: grep/file maps, symbol/log filters, candidate file:line anchors, or hypotheses with a strict output cap and no durable verdict.`,
    `Use model="${explorerFallbackModel()}" for multi-hop tracing, compact synthesis, bounded verification, config/test interpretation, or light low-risk execution where the child owns a durable conclusion.`,
    `Use model="gpt-5.5" only for critic, architecture, security, high-risk implementation, live-money/destructive judgment, or final approval.`,
    `Do not set agent_type=explorer with model="${explorerForbiddenModels().join("|")}". Frontier critic/architecture/high-risk lanes must use agent_type=default; explorer lanes must use ${explorerModel()} or ${explorerFallbackModel()}.`,
    "Do not combine fork_context=true with model. If you need Spark/mini/frontier model routing, remove fork_context and pass a compact context packet in message/items. Use fork_context=true without model only when exact full-history context matters more than model routing; that path may inherit the parent model.",
    "If you cannot state the child output cap and stop condition, do not use Spark; slice locally first or choose mini.",
    "Capacity is a separate decision: without runtime reservation, do not submit multiple spawn_agent calls in one tool batch; spawn one child, let runtime record it, then re-check observed_free.",
    "For broad, compiled, vendor, or large-context repos, first make a local module/file map; then give Spark exact slices to anchor, and use mini/frontier for synthesis.",
    "This judgment step is mandatory; never omit model, because omitted model inherits the parent frontier model.",
    "This is a spawn-shape guard, not a recommendation to create a subagent.",
  ].join(" ");
}

function buildCapacityGuidance(eventName, cap, summary = null) {
  return [
    buildTurnBudgetGuidance(summary, cap),
    buildSubagentModelSelectionGuidance(),
    `Native subagent capacity protocol (launch sequencing only): this Codex parent/session has a child-agent cap of ${cap}. Capacity accounting is per parent/session; rows from other parent sessions must not change this turn's admission decision.`,
    "Without a Codex runtime reservation primitive, this hook cannot guarantee atomic multi-spawn success. Prefer single-spawn-then-resample sequencing; if any spawn returns a capacity failure, stop spawning until a later close, repair, or explicit reset refreshes observed capacity.",
    "Open children without task_complete evidence can consume slots until close succeeds; stale open edges with task_complete evidence are repaired to closed and excluded from current occupancy.",
    "If cap_hit_blocks_spawn=yes, do not call spawn_agent again until a later close, repair, or explicit reset refreshes budget. If cap_hit_after_last_close=yes but cap_hit_blocks_spawn=no, trust the current authoritative native slot count instead of the stale cap-hit.",
    "Do not restate/retry long child prompts after a capacity failure.",
    "This protocol does not recommend delegation, reuse, or messaging a child lane; it only prevents wasteful native pool collisions.",
  ].filter(Boolean).join(" ");
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
  const trackedAgentIds = agents.map((agent) => safeString(agent.id).trim()).filter(Boolean);
  const pendingSpawnReservations = spawnReservationCount(session);
  const trackedOccupied = running + terminal;
  return {
    running,
    terminal,
    tracked_agent_ids: trackedAgentIds,
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

function mergeSummary(
  sessionSummary,
  transcriptPool,
  childSessionIds,
  nativeThreadEdges,
  session,
  resetAtMs = 0,
  cap = DEFAULT_AGENT_CAP,
) {
  const capValue = slotCap(cap);
  const nativeClosed = new Set(nativeThreadEdges?.closed ?? []);
  const nativeActive = new Set(nativeThreadEdges?.active ?? []);
  const nativeTerminal = new Set(nativeThreadEdges?.terminal ?? []);
  const nativeLanes = nativeThreadEdges?.lanes instanceof Map ? nativeThreadEdges.lanes : new Map();
  const nativeChecked = Boolean(nativeThreadEdges?.checked && !nativeThreadEdges?.failed);
  const nativeAuthoritative = nativeChecked;
  const transcriptActive = new Set(transcriptPool.active ?? []);
  if (!nativeAuthoritative) {
    for (const id of childSessionIds ?? []) {
      if (!transcriptPool.closed?.has(id) && !nativeClosed.has(id)) transcriptActive.add(id);
    }
  }
  for (const id of nativeClosed) {
    transcriptActive.delete(id);
  }

  const transcriptUnresolved = transcriptActive.size;
  const transcriptEstimateCanOverrideFallback = Boolean(
    transcriptPool.slotEstimateReliable && transcriptPool.slotEstimateEvents > 0,
  );
  const transcriptSlotOccupied = clampSlotCount(
    transcriptEstimateCanOverrideFallback ? transcriptPool.slotOccupied : transcriptUnresolved,
    capValue,
  );
  const transcriptSlotReliable = transcriptEstimateCanOverrideFallback;
  const nativeUnresolved = nativeActive.size + nativeTerminal.size;
  const nativeSlotActive = clampSlotCount(nativeActive.size, capValue);
  const nativeSlotTerminal = clampSlotCount(
    Math.min(nativeTerminal.size, Math.max(0, capValue - nativeSlotActive)),
    capValue,
  );
  const nativeSlotOccupied = clampSlotCount(nativeSlotActive + nativeSlotTerminal, capValue);
  const nativeEdgeOverflow = Math.max(0, nativeUnresolved - capValue);
  const trackedUnresolved = sessionSummary.tracked_occupied ?? sessionSummary.occupied;
  const trackedOccupied = clampSlotCount(trackedUnresolved, capValue);
  const trackedAgentIds = new Set(sessionSummary.tracked_agent_ids ?? []);
  const nativeLedgerLagIds = nativeAuthoritative
    ? [...trackedAgentIds].filter((id) => !nativeActive.has(id) && !nativeTerminal.has(id) && !nativeClosed.has(id))
    : [];
  const nativeLedgerLag = nativeLedgerLagIds.length;
  const pendingSpawnReservations = sessionSummary.pending_spawn_reservations ?? 0;
  const rawLastCapHitMs = Math.max(
    transcriptPool.capHitAtMs || 0,
    msFromIso(session.last_cap_hit_at),
  );
  const rawLastCloseMs = Math.max(
    transcriptPool.lastCloseAtMs || 0,
    msFromIso(session.last_close_at),
  );
  const lastCapHitMs = rawLastCapHitMs > resetAtMs ? rawLastCapHitMs : 0;
  const lastCloseMs = Math.max(rawLastCloseMs, resetAtMs);
  const capHitAfterLastClose = lastCapHitMs > 0 && lastCapHitMs > lastCloseMs;
  const capHitBlocksSpawn = Boolean(capHitAfterLastClose && !nativeAuthoritative);
  let evidenceOccupied = transcriptSlotOccupied;
  let slotPressureSource = "transcript_fallback";
  if (nativeAuthoritative) {
    evidenceOccupied = clampSlotCount(nativeUnresolved + nativeLedgerLag, capValue);
    slotPressureSource = nativeUnresolved > capValue
      ? "native_open_edges_saturated"
      : nativeLedgerLag > 0
      ? "native_open_edges_plus_ledger"
      : "native_open_edges";
  } else if (transcriptSlotReliable) {
    evidenceOccupied = transcriptSlotOccupied;
    slotPressureSource = "transcript_events";
  }
  const trackedAdmission = nativeAuthoritative ? 0 : trackedOccupied;
  const effectiveOccupied = capHitBlocksSpawn
    ? capValue
    : clampSlotCount(Math.max(trackedAdmission, evidenceOccupied) + pendingSpawnReservations, capValue);

  return {
    ...sessionSummary,
    occupied: effectiveOccupied,
    tracked_occupied: trackedOccupied,
    tracked_unresolved: trackedUnresolved,
    transcript_occupied: transcriptSlotOccupied,
    transcript_unresolved: transcriptUnresolved,
    transcript_slot_reliable: transcriptSlotReliable,
    transcript_slot_events: transcriptPool.slotEstimateEvents ?? 0,
    pending_spawn_reservations: pendingSpawnReservations,
    transcript_scanned: Boolean(transcriptPool.scanned),
    transcript_truncated: Boolean(transcriptPool.truncated),
    discovered_child_sessions: childSessionIds?.size ?? 0,
    native_edge_checked: Boolean(nativeThreadEdges?.checked),
    native_edge_authoritative: nativeAuthoritative,
    native_edge_failed: Boolean(nativeThreadEdges?.failed),
    native_edge_active: nativeSlotActive,
    native_edge_active_debt: nativeActive.size,
    native_edge_closed: nativeClosed.size,
    native_edge_terminal: nativeSlotTerminal,
    native_edge_terminal_debt: nativeTerminal.size,
    native_edge_slot_occupied: nativeSlotOccupied,
    native_edge_debt: nativeUnresolved,
    native_edge_unresolved: nativeUnresolved,
    native_edge_ledger_lag: nativeLedgerLag,
    native_edge_ledger_lag_ids: nativeLedgerLagIds.slice(0, capValue),
    native_edge_overflow: nativeEdgeOverflow,
    native_edge_cap: capValue,
    slot_pressure_source: slotPressureSource,
    native_terminal_ids: [...nativeTerminal].slice(0, nativeSlotTerminal),
    native_terminal_lanes: [...nativeTerminal]
      .slice(0, nativeSlotTerminal)
      .map((id) => nativeLanes.get(id) ?? { id }),
    native_active_lanes: [...nativeActive]
      .slice(0, nativeSlotActive)
      .map((id) => nativeLanes.get(id) ?? { id }),
    native_edge_repaired: nativeThreadEdges?.repaired ?? 0,
    failed_spawns: transcriptPool.failedSpawns ?? 0,
    failed_closes: (transcriptPool.failedCloses ?? 0) + (msFromIso(session.last_close_failed_at) > lastCloseMs ? 1 : 0),
    last_cap_hit_at: isoFromMs(lastCapHitMs),
    last_close_at: isoFromMs(lastCloseMs),
    native_pool_reset_at: isoFromMs(resetAtMs),
    cap_hit_after_last_close: capHitAfterLastClose,
    cap_hit_blocks_spawn: capHitBlocksSpawn,
  };
}

function shouldBlockSpawn(eventName, name, summary, cap, isChildSession, payload = null, operations = null) {
  if (eventName !== "PreToolUse") return false;
  const ops = operations ?? agentOperations(payload ?? {}, name);
  const requestedSpawns = spawnOperationCount(ops);
  if (requestedSpawns === 0) return false;
  if (isChildSession) return true;
  if (hasForkContextModelConflictInOperations(ops)) return true;
  if (hasMissingSpawnModelInOperations(ops)) return true;
  if (hasExplorerForbiddenModelInOperations(ops)) return true;
  if (summary.native_edge_failed) return true;
  if ((summary.pending_spawn_reservations ?? 0) > 0) return true;
  if (requestedSpawns > 1) return true;
  if (summary.occupied + requestedSpawns > cap) return true;
  if (!summary.native_edge_authoritative && summary.tracked_occupied + requestedSpawns > cap) return true;
  if (
    !summary.native_edge_authoritative
    && summary.transcript_scanned
    && summary.transcript_occupied + requestedSpawns > cap
  ) {
    return true;
  }
  return Boolean(summary.cap_hit_blocks_spawn);
}

function shouldEmitAdvisory(eventName, name, summary, cap, operations = null) {
  const ops = operations ?? agentOperations({}, name);
  if (ops.length === 0) return false;
  if (hasMissingSpawnModelInOperations(ops)) return true;
  if (hasExplorerForbiddenModelInOperations(ops)) return true;
  if (summary.terminal > 0) return true;
  if ((summary.native_edge_terminal ?? 0) > 0) return true;
  if (hasForkContextModelInheritanceInOperations(ops)) return true;
  const threshold = Math.max(1, cap - warnRemaining());
  return summary.occupied >= threshold && (eventName === "PreToolUse" || eventName === "PostToolUse");
}

function buildAdvisory(eventName, summary, cap, blockSpawn, isChildSession, payload = null, operations = null) {
  const ops = operations ?? agentOperations(payload ?? {}, "");
  const checkSpawnShape = !isChildSession;
  const missingSpawnModel = checkSpawnShape && hasMissingSpawnModelInOperations(ops);
  const forkContextModelConflict = checkSpawnShape && hasForkContextModelConflictInOperations(ops);
  const forkContextModelInheritance = checkSpawnShape && hasForkContextModelInheritanceInOperations(ops);
  const explorerForbiddenModel = checkSpawnShape && hasExplorerForbiddenModelInOperations(ops);
  const requestedSpawns = spawnOperationCount(ops);
  const snapshot = capacitySnapshot(summary, cap, requestedSpawns);
  const multiSpawnWithoutReservation = requestedSpawns > 1 && !snapshot.runtime_reservation;
  const parts = [
    `${blockSpawn ? "Native agent pool guard" : "Native agent pool advisory"}: ${summary.occupied}/${cap} estimated slots occupied`,
    formatCapacitySnapshot(snapshot),
    `slot_pressure_source=${summary.slot_pressure_source}`,
    `ledger_slot=${summary.tracked_occupied}`,
    `ledger_unresolved=${summary.tracked_unresolved}`,
    `transcript_slot=${summary.transcript_occupied}`,
    `transcript_unresolved=${summary.transcript_unresolved}`,
    `native_slots=${nativeEdgeSummary(summary)}`,
    `reserved_spawns=${summary.pending_spawn_reservations}`,
    `running=${summary.running}`,
    `completed_not_closed=${summary.terminal}`,
    `failed_closes=${summary.failed_closes}`,
    `cap_hit_after_last_close=${summary.cap_hit_after_last_close ? "yes" : "no"}`,
    `cap_hit_blocks_spawn=${summary.cap_hit_blocks_spawn ? "yes" : "no"}`,
  ];

  const context = [
    parts.join(", ") + ".",
    forkContextModelConflict
      ? "Subagent spawn is blocked because fork_context=true cannot be combined with an explicit model in this runtime shape. This is a tool-shape failure, not native-pool exhaustion. If model routing matters, remove fork_context and include the necessary compact context in message/items, then retry one corrected spawn only after a refreshed observed_free snapshot is positive. If exact full-history fork matters more, omit model intentionally and accept inherited parent model."
      : null,
    missingSpawnModel
      ? (blockSpawn
        ? `Subagent spawn is blocked until tool input includes an explicit model. Before retrying, decide task_contract={output,risk,state_depth,context_size,edit_permission,final_authority,output_cap,stop_condition}. Default to ${explorerFallbackModel()} when the task does not require a specialist model; use ${explorerModel()} only for capped scout/anchor work and gpt-5.5 only for critic, architecture, security, high-risk implementation, live-money/destructive judgment, or final approval.`
        : `Missing model route violation observed after tool execution: spawn_agent ran without an explicit model. Treat this child as a failed routing decision unless fork_context=true was intentionally used for exact full-history inheritance. Future non-fork spawns must include the model field in the tool input.`)
      : null,
    explorerForbiddenModel
      ? (blockSpawn
        ? `Explorer/frontier route violation: native agent_type=explorer cannot use model="${explorerForbiddenModels().join("|")}". Explorer lanes are for scout/anchor work and should use ${explorerModel()} or ${explorerFallbackModel()}; if this is truly critic, architecture, security, high-risk, live-money judgment, or final approval, change the native role to agent_type=default and keep the explicit frontier model.`
        : `Explorer/frontier route violation observed after tool execution: a spawn_agent call used native agent_type=explorer with a forbidden frontier model. Future frontier critic/architecture lanes must use agent_type=default; future explorer lanes must use ${explorerModel()} or ${explorerFallbackModel()}.`)
      : null,
    forkContextModelInheritance
      ? "Fork-context model inheritance exception: fork_context=true without model is allowed only because full-history fork may not support explicit model routing. Use it sparingly; for explorer/scout/mini routing, remove fork_context and pass compact context instead."
      : null,
    multiSpawnWithoutReservation
      ? "Multiple spawn_agent calls in one tool operation are blocked because observed_free is not an atomic runtime reservation. Split the batch: launch one child, let PostToolUse/native state record the result, then re-check observed_free before the next child."
      : null,
    blockSpawn && isChildSession
      ? "Nested native spawn is blocked: child sessions cannot create subagents; the parent leader owns delegation."
      : null,
    blockSpawn
      ? (forkContextModelConflict
        ? "Correct the spawn shape and retry only one corrected spawn call after the refreshed observed_free check; do not treat this as a consumed native slot or as proof the pool is full."
        : missingSpawnModel
        ? "Retry only after making model-selection judgment explicit; Analyze/read-only/bounded labels are not enough, and the corrected call must still fit observed_free."
        : explorerForbiddenModel
        ? "Retry only after correcting the role/model shape: explorer with Spark/mini for scout work, or default with explicit frontier model for critic/architecture/high-risk judgment. Do not re-label a frontier critic lane as explorer."
        : multiSpawnWithoutReservation
        ? "Retry as a single spawn call, then resample capacity before launching another child; do not restate every child prompt after a batch block."
        : isChildSession
        ? "Nested spawn denied; no child-side delegation guidance is emitted."
        : (summary.cap_hit_blocks_spawn
          ? "This thread already saw a native pool-exhaustion failure after the last confirmed close/repair/reset; do not retry spawn_agent until a later close/repair/reset succeeds and a newer hook/PreToolUse capacity check reports budget."
          : "This spawn is likely to fail or race another pending spawn reservation; do not restate the long spawn prompt in commentary and do not stop at saying the pool is full. Reuse a compatible lane, close listed no-longer-needed current-parent lane(s) when the leader knows they are obsolete, wait for a needed active lane, or continue locally; then resample capacity and retry only within a fresh positive observed_free snapshot."))
      : "Completed subagents are reusable context lanes and still consume native slots until closed; pending spawn reservations also count until the spawn succeeds, fails, or expires.",
    (summary.native_edge_overflow ?? 0) > 0
      ? `Native DB open-edge debt exceeds the runtime cap; occupied is intentionally saturated at the cap, and overflow rows are repair debt rather than additional live agents. db_open_edge_debt=${summary.native_edge_debt}, open_edge_overflow=${summary.native_edge_overflow}.`
      : null,
    summary.failed_closes > 0
      ? "At least one recent close was not confirmed; treat capacity as uncertain and serialize follow-up spawns."
      : null,
    summary.native_edge_failed
      ? "Native thread_spawn_edges could not be read; spawn capacity is unknown, so serialize and retry only after the state read succeeds."
      : null,
	    "This hook does not choose whether delegation is needed and does not emit proactive child-agent guidance; it only surfaces current-parent native pool pressure and enforces the no-recursive-spawn boundary.",
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
      ? (isChildSession
        ? "Blocking nested spawn_agent; child sessions cannot create subagents."
        : `Blocking spawn_agent conservatively. The native cap is ${cap}; retry only after the lock clears and a refreshed observed_free snapshot can be read, or continue locally.`)
      : "Serialize agent-pool operations until the lock clears.",
    isChildSession ? "This is a child session; nested native spawn remains disallowed." : null,
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
    if (eventName === "PreToolUse" && hasSpawnOperation(operations) && identity.unscoped) {
      const context = `Native agent pool guard: blocking spawn_agent because this hook payload has no session_id, thread_id, transcript_path session_meta, or parent_thread_id. Capacity is scoped per parent/session; an unscoped payload must not fall back to a shared cwd bucket. Retry only after Codex provides a scoped parent/session identity.`;
      process.stdout.write(`${JSON.stringify({
        decision: "block",
        reason: context,
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: context,
        },
      })}\n`);
      return;
    }

    const lockResult = await withStateLock(async () => {
      const state = await readState();
      await maintainNativePoolStorage(state, nowMs, nowIso);
      pruneAdvisorSessions(state, nowMs);
      const session = normalizeSession(state, identity.key);
      pruneStaleRunningAgents(session, nowMs);
      pruneSpawnReservations(session, nowMs);

      const prompt = promptText(payload);
      if (eventName === "SessionStart" || eventName === "UserPromptSubmit") {
        let promptSummary = null;
        if (eventName === "SessionStart" || eventName === "UserPromptSubmit") {
          const resetAtMs = nativePoolResetMs(state, identity.poolThreadId || identity.threadId);
          const { transcriptPool, childSessionIds, nativeThreadEdges } = await collectPoolEvidence(identity, nowMs, resetAtMs, cap);
          applyTranscriptEvidenceToSession(session, transcriptPool);
          applyNativeThreadEdgesToSession(session, nativeThreadEdges);
          promptSummary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
        }
        const emitCapacity = shouldEmitCapacityGuidance(eventName, prompt, session, nowMs, identity.isChildSession, promptSummary, cap);
        if (emitCapacity) markCapacityGuidanceEmitted(eventName, prompt, session, nowIso);
        session.updated_at = nowIso;
        state.updated_at = nowIso;
        await writeState(state);
        if (emitCapacity) {
          const contexts = [
            emitCapacity ? buildCapacityGuidance(eventName, cap, promptSummary) : "",
          ];
          process.stdout.write(`${JSON.stringify(buildPromptGuidanceOutput(eventName, contexts))}\n`);
        }
        return;
      }

      if (operations.length === 0) return;

      const resetAtMs = nativePoolResetMs(state, identity.poolThreadId || identity.threadId);
      const { transcriptPool, childSessionIds, nativeThreadEdges } = await collectPoolEvidence(identity, nowMs, resetAtMs, cap);
      applyNativeThreadEdgesToSession(session, nativeThreadEdges);

      const isPreSpawn = eventName === "PreToolUse" && hasSpawnOperation(operations);
      let summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
      let blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);

      if (isPreSpawn && !blockSpawn) {
        reserveSpawnSlot(session, payload, nowMs, nowIso, spawnOperationCount(operations));
        summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
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

          const missingCloseIds = closeLooksTargetMissing(operationPayload)
            ? collectCloseTargetIds(operationPayload)
            : [];
          if (missingCloseIds.length > 0) {
            const repairedIds = await repairClosedNativeEdgeIds(identity.poolThreadId, missingCloseIds);
            const unrepairedMissingIds = missingCloseIds.filter((id) => !repairedIds.has(id));
            const uniqueRepairedParents = await repairUniqueMissingNativeEdgeIds(unrepairedMissingIds);
            const nativeAuthoritative = Boolean(nativeThreadEdges?.checked && !nativeThreadEdges?.failed);
            const currentParentUniqueIds = new Set(
              [...uniqueRepairedParents.entries()]
                .filter(([, parentId]) => parentId === identity.poolThreadId)
                .map(([id]) => id),
            );
            const currentParentRepairedIds = new Set([...repairedIds, ...currentParentUniqueIds]);
            const verifiedFallbackMissingIds = missingCloseIds.filter((id) => {
              return Boolean(session.agents?.[id]) || transcriptPool.active.has(id) || transcriptPool.spawned.has(id);
            });
            const effectiveIds = nativeAuthoritative
              ? currentParentRepairedIds
              : new Set([...currentParentRepairedIds, ...verifiedFallbackMissingIds]);
            for (const id of effectiveIds) {
              delete session.agents[id];
              nativeThreadEdges.active?.delete(id);
              nativeThreadEdges.terminal?.delete(id);
              nativeThreadEdges.closed?.add(id);
              transcriptPool.active.delete(id);
              transcriptPool.closed.add(id);
              transcriptPool.missingClosed.add(id);
            }
            if (effectiveIds.size > 0) session.last_close_at = nowIso;
            continue;
          }

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
        summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
        blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);
      }

      applyTranscriptEvidenceToSession(session, transcriptPool);

      session.updated_at = nowIso;
      state.updated_at = nowIso;
      await writeState(state);

      summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
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

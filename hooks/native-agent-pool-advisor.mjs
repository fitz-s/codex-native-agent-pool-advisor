#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
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
const POST_TOOL_CAPACITY_GUIDANCE_TTL_MS = 60 * 1000;
const SPAWN_SHAPE_REMINDER_TTL_MS = 30 * 60 * 1000;
const NATIVE_LEDGER_LAG_TTL_MS = 5 * 60 * 1000;
const STATE_LOCK_WAIT_MS = 2500;
const STATE_LOCK_STALE_MS = 10000;
const NATIVE_EDGE_QUERY_TIMEOUT_MS = 750;
const NATIVE_EDGE_QUERY_MAX_BUFFER = 1024 * 1024;
const NATIVE_EDGE_TERMINAL_TAIL_BYTES = 2 * 1024 * 1024;
const NATIVE_EDGE_REPAIR_BATCH = 50;
const TRANSCRIPT_MENTIONED_CHILD_REF_QUERY_LIMIT = 1000;
const NATIVE_EDGE_MAINTENANCE_TTL_MS = 6 * 60 * 60 * 1000;
const NATIVE_EDGE_CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_ORPHAN_VISIBLE_RETENTION_MS = 24 * 60 * 60 * 1000;
const NATIVE_STALE_OPEN_EDGE_RETENTION_MS = 0;
const NATIVE_CLOSE_REQUEST_GRACE_MS = 90 * 1000;
const NATIVE_EDGE_CLOSED_PRUNE_BATCH = 5000;
const ADVISOR_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_SUBAGENT_CONTEXT_SANITIZE_MAX_BYTES = 512 * 1024 * 1024;
const TRANSCRIPT_SUBAGENT_CONTEXT_STREAM_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const TRANSCRIPT_SANITIZE_STREAM_CHUNK_BYTES = 1024 * 1024;
const TRANSCRIPT_SANITIZE_STREAM_OVERLAP_CHARS = 1024;
const TRANSCRIPT_SUBAGENT_CONTEXT_SANITIZE_TTL_MS = 30 * 60 * 1000;
const GLOBAL_STATE_CONTEXT_SANITIZE_MAX_BYTES = 16 * 1024 * 1024;
const COMMAND_NAME = "native-agent-pool-advisor";
const DEFAULT_STATE_DB_NAME = "state_5.sqlite";
const DEFAULT_EXPLORER_MODEL = "gpt-5.6-luna";
const DEFAULT_EXPLORER_FALLBACK_MODEL = "gpt-5.6-terra";
const DEFAULT_EXPLORER_FORBIDDEN_MODELS = ["gpt-5.6-sol"];
const DEFAULT_SUBAGENT_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
const DEFAULT_ALLOWED_AGENT_TYPES = [];
const SPAWN_LOCK_WAIT_MS = 100;
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
  allowedAgentTypes: [...DEFAULT_ALLOWED_AGENT_TYPES],
  closedEdgeRetentionMs: NATIVE_EDGE_CLOSED_RETENTION_MS,
  orphanVisibleRetentionMs: NATIVE_ORPHAN_VISIBLE_RETENTION_MS,
  staleOpenEdgeRetentionMs: NATIVE_STALE_OPEN_EDGE_RETENTION_MS,
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

function codexGlobalStatePath() {
  return join(codexHome(), ".codex-global-state.json");
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

function readFirstNonNegativeInteger(fallback, ...values) {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
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
  const configuredAgentTypes = parseStringList(
    process.env.NATIVE_AGENT_POOL_ALLOWED_AGENT_TYPES
      ?? models.allowed_agent_types
      ?? models.allowedAgentTypes
      ?? models.native_agent_types
      ?? models.nativeAgentTypes
      ?? DEFAULT_ALLOWED_AGENT_TYPES,
  ).map((role) => normalizeAgentRole(role)).filter(Boolean);
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
    allowedAgentTypes: configuredAgentTypes.length > 0
      ? [...new Set(configuredAgentTypes)]
      : [...DEFAULT_ALLOWED_AGENT_TYPES],
    closedEdgeRetentionMs: readFirstPositiveInteger(
      Math.floor(NATIVE_EDGE_CLOSED_RETENTION_MS / (60 * 60 * 1000)),
      process.env.NATIVE_AGENT_POOL_CLOSED_EDGE_RETENTION_HOURS,
      defaults.closed_edge_retention_hours,
      defaults.closedEdgeRetentionHours,
    ) * 60 * 60 * 1000,
    orphanVisibleRetentionMs: readFirstPositiveInteger(
      Math.floor(NATIVE_ORPHAN_VISIBLE_RETENTION_MS / (60 * 60 * 1000)),
      process.env.NATIVE_AGENT_POOL_ORPHAN_VISIBLE_RETENTION_HOURS,
      defaults.orphan_visible_retention_hours,
      defaults.orphanVisibleRetentionHours,
    ) * 60 * 60 * 1000,
    staleOpenEdgeRetentionMs: readFirstNonNegativeInteger(
      Math.floor(NATIVE_STALE_OPEN_EDGE_RETENTION_MS / (60 * 60 * 1000)),
      process.env.NATIVE_AGENT_POOL_STALE_OPEN_EDGE_RETENTION_HOURS,
      defaults.stale_open_edge_retention_hours,
      defaults.staleOpenEdgeRetentionHours,
    ) * 60 * 60 * 1000,
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

function supportedSubagentModels() {
  return [...DEFAULT_SUBAGENT_MODELS];
}

function allowedAgentTypes() {
  const configured = Array.isArray(runtimeOptionsCache.allowedAgentTypes)
    ? runtimeOptionsCache.allowedAgentTypes
    : [];
  const roles = configured.map((role) => normalizeAgentRole(role)).filter(Boolean);
  return roles.length > 0 ? [...new Set(roles)] : [...DEFAULT_ALLOWED_AGENT_TYPES];
}

function closedEdgeRetentionMs() {
  return runtimeOptionsCache.closedEdgeRetentionMs > 0
    ? runtimeOptionsCache.closedEdgeRetentionMs
    : NATIVE_EDGE_CLOSED_RETENTION_MS;
}

function orphanVisibleRetentionMs() {
  return runtimeOptionsCache.orphanVisibleRetentionMs > 0
    ? runtimeOptionsCache.orphanVisibleRetentionMs
    : NATIVE_ORPHAN_VISIBLE_RETENTION_MS;
}

function staleOpenEdgeRetentionMs() {
  return runtimeOptionsCache.staleOpenEdgeRetentionMs > 0
    ? runtimeOptionsCache.staleOpenEdgeRetentionMs
    : 0;
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

async function acquireStateLock(waitMs = STATE_LOCK_WAIT_MS) {
  const lockPath = stateLockPath();
  const ownerPath = join(lockPath, "owner");
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
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

async function withStateLock(work, waitMs = STATE_LOCK_WAIT_MS) {
  const lock = await acquireStateLock(waitMs);
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

function shouldStreamLargeTranscriptSanitize() {
  return safeString(process.env.NATIVE_AGENT_POOL_FORCE_LARGE_TRANSCRIPT_SANITIZE).trim() === "1";
}

function normalizeToolName(name) {
  return safeString(name).trim().replace(/^functions\./, "");
}

function shellCommandText(payload) {
  const input = toolInput(payload);
  return [input.cmd, input.command, input.script].map((value) => safeString(value)).find(Boolean) ?? "";
}

function invokesExternalCodexExec(payload, name) {
  if (!new Set(["bash", "shell", "exec_command", "terminal"]).has(normalizeToolName(name).toLowerCase())) {
    return false;
  }
  return /(?:^|[\s;|&()])(?:\S+\/)?codex\s+exec(?:\s|$)/i.test(shellCommandText(payload));
}

function externalCodexExecGuard(eventName, payload, name) {
  if (eventName !== "PreToolUse" || !invokesExternalCodexExec(payload, name)) return null;
  const context = "Native-agent pool guard: blocking `codex exec` from this interactive task. A CLI worker is outside the current parent/session native pool, cannot reconcile its lifecycle with native edges, and can reintroduce unmanaged agent context. Use the native spawn surface with an explicit gpt-5.6 model, or continue locally when delegation is not needed.";
  return {
    decision: "block",
    reason: context,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
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

async function readFileTail(path, byteLimit = 64 * 1024) {
  if (!path) return "";
  let handle;
  try {
    const stats = await stat(path);
    const start = Math.max(0, stats.size - byteLimit);
    handle = await open(path, "r");
    const buffer = Buffer.alloc(stats.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
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

function parentThreadIdFromSourceText(text) {
  const raw = safeString(text).trim();
  if (!raw || !raw.includes("parent_thread_id")) return "";
  try {
    return parentThreadIdFromChildMeta({ source: JSON.parse(raw) });
  } catch {
    return "";
  }
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
    closeRequested: new Map(),
    slotOccupied: 0,
    slotEstimateEvents: 0,
    slotEstimateReliable: false,
    slotEstimateSawCapHit: false,
    failedSpawns: 0,
    failedCloses: 0,
    capHitAtMs: 0,
    lastCloseAtMs: 0,
    lastSpawnSuccessAtMs: 0,
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
  const clearCloseRequestEvidence = (ids, outputMs = 0) => {
    for (const id of ids ?? []) {
      const requestedAtMs = pool.closeRequested.get(id);
      if (!requestedAtMs) continue;
      if (outputMs > 0 && requestedAtMs > outputMs) continue;
      pool.closeRequested.delete(id);
    }
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
        pool.lastSpawnSuccessAtMs = Math.max(pool.lastSpawnSuccessAtMs, eventTimestampMs(record));
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
          pool.lastSpawnSuccessAtMs = Math.max(pool.lastSpawnSuccessAtMs, eventTimestampMs(record));
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
        clearCloseRequestEvidence(closeIds, eventTimestampMs(record));
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
    for (const id of closeIds) {
      const atMs = eventTimestampMs(record);
      if (atMs > 0) pool.closeRequested.set(id, Math.max(pool.closeRequested.get(id) ?? 0, atMs));
    }
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
    clearCloseRequestEvidence(closeIds, eventTimestampMs(record));
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
    visible: new Set(),
    lanes: new Map(),
    checked: false,
    failed: false,
    repaired: 0,
    visible_checked: false,
    visible_archived: 0,
  };
}

function sqlString(value) {
  return `'${safeString(value).replace(/'/g, "''")}'`;
}

function escapeRegExpLiteral(value) {
  return safeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeSubagentContextLine(text, id) {
  const target = safeString(id).trim();
  if (!target) return { text, removed: 0 };
  let current = safeString(text);
  let removed = 0;
  for (const marker of [`\\n    - ${target}:`, `\n    - ${target}:`]) {
    const terminator = marker.startsWith("\\n") ? "\\n" : "\n";
    for (;;) {
      const start = current.indexOf(marker);
      if (start < 0) break;
      const end = current.indexOf(terminator, start + marker.length);
      if (end < 0) break;
      current = `${current.slice(0, start)}${terminator}${current.slice(end + terminator.length)}`;
      removed += 1;
    }
  }
  return { text: current, removed };
}

function replacementCount(text, needle) {
  const target = safeString(needle).trim();
  if (!target) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = text.indexOf(target, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + target.length;
  }
}

function scrubNonOpenChildReferenceText(text, ref) {
  let current = safeString(text);
  let removed = 0;
  const id = safeString(ref?.id).trim();
  if (id) {
    removed += replacementCount(current, id);
    current = current.split(id).join("[archived-child-id]");
    const shortId = id.slice(0, 8);
    if (shortId.length >= 8) {
      const shortPattern = new RegExp(`\\b${escapeRegExpLiteral(shortId)}\\b`, "g");
      const matches = current.match(shortPattern);
      if (matches) {
        removed += matches.length;
        current = current.replace(shortPattern, "[archived-child-id]");
      }
    }
  }

  for (const label of [ref?.nickname, ref?.title]) {
    const value = safeString(label).trim();
    if (value.length < 3) continue;
    if (/^(?:agent|default|explore|debugger|critic|reviewer|worker)$/i.test(value)) continue;
    const pattern = new RegExp(`\\b${escapeRegExpLiteral(value)}\\b`, "g");
    const matches = current.match(pattern);
    if (!matches) continue;
    removed += matches.length;
    current = current.replace(pattern, "[archived-child]");
  }
  for (const legacyPlaceholder of ["stale-closed-agent", "stale-closed-handle"]) {
    const matches = current.match(new RegExp(escapeRegExpLiteral(legacyPlaceholder), "g"));
    if (!matches) continue;
    removed += matches.length;
    current = current.split(legacyPlaceholder).join("[archived-child]");
  }
  return { text: current, removed };
}

function scrubNativeDisplayNameContextText(text) {
  let current = safeString(text);
  let removed = 0;
  const placeholder = "[removed-native-display-label]";
  const replace = (pattern) => {
    current = current.replace(pattern, () => {
      removed += 1;
      return placeholder;
    });
  };
  const replaceValue = (pattern) => {
    current = current.replace(pattern, (...args) => {
      const groups = args.at(-1);
      removed += 1;
      if (groups && typeof groups === "object" && Object.hasOwn(groups, "prefix")) {
        return `${groups.prefix}${placeholder}${groups.suffix ?? ""}`;
      }
      return placeholder;
    });
  };
  const nativeRolePattern = "(?:explore|debugger|verifier|test-engineer|critic|code-reviewer|architect|researcher|executor|dependency-expert|default)";
  replaceValue(/(?<prefix>"(?:nickname|agent_nickname)"\s*:\s*")(?<value>[^"\n\r]{1,160})(?<suffix>")/gi);
  replaceValue(/(?<prefix>'(?:nickname|agent_nickname)'\s*:\s*')(?<value>[^'\n\r]{1,160})(?<suffix>')/gi);
  replaceValue(/(?<prefix>\\+"(?:nickname|agent_nickname)\\+"\s*:\s*\\+")(?<value>[^"\\\n\r]{1,160})(?<suffix>\\+")/gi);
  replaceValue(/(?<prefix>\b(?:nickname|agent_nickname)=)(?<value>[^\s,|)]{1,160})/gi);
  replace(/(?:正在关闭|无法关闭|已关闭|关闭失败|已创建|创建中|创建失败)\s*(?:(?:正在关闭|无法关闭|已关闭|关闭失败|已创建|创建中|创建失败)\s*)?\d+\s*个智能体/gi);
  replace(/当前父会话里还有\s*\d+\s*个旧\s*subagent\s*槽位/gi);
  replace(new RegExp(`(?:正在关闭|无法关闭|已关闭|关闭失败|创建中|已创建|创建失败)[^\\n\\r]{0,220}\\s+[^\\n\\r"'\\\`{}[\\]]+?\\s*\\(${nativeRolePattern}\\)`, "gi"));
  replace(new RegExp(`(?:正在关闭|无法关闭|已关闭|关闭失败|创建中|已创建|创建失败)[^\\n\\r]{0,220}\\s+\\[archived-child\\]\\s*\\(${nativeRolePattern}\\)`, "gi"));
  replace(new RegExp(`\\b(?:closing|closed|close failed|creating|created|spawn failed)\\b[^\\n\\r]{0,220}\\s+[^\\n\\r"'\\\`{}[\\]]+?\\s*\\(${nativeRolePattern}\\)`, "gi"));
  replace(/\bAgent\s+"[^"\n\r]{1,160}"\s+(?:completed|failed|canceled|cancelled)\b/gi);
  replace(/\bAgent\s+\\+"[^"\\\n\r]{1,160}\\+"\s+(?:completed|failed|canceled|cancelled)\b/gi);
  current = current.replace(/(\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\s*)[A-Z][A-Za-z0-9_. -]{1,80}(?=(?:\\n|\n|\\r|\r|<))/gi, (match, prefix) => {
    removed += 1;
    return `${prefix}${placeholder}`;
  });
  current = current.replace(/(^|\\n|\\r|[^A-Za-z])([A-Z][A-Za-z0-9_. -]{1,80})\s+(review\b|在审|还没返回|已关闭|返回了|查|的[^\\\n\r]{0,60}?返回)/g, (match, prefix, label) => {
    const value = safeString(label).trim();
    if (value.length < 5 || /^(?:This|That|Current|Code|No|Test|Review)$/i.test(value)) return match;
    removed += 1;
    return `${prefix}${placeholder}`;
  });
  replace(/\b[A-Za-z][A-Za-z0-9_. -]{1,80}\s*又在被关闭/gi);
  replace(new RegExp(`\\[archived-child\\]\\s*\\(${nativeRolePattern}\\)`, "gi"));
  replace(new RegExp(`\\b(?!019[0-9a-f-]{20,}\\b)[A-Za-z][A-Za-z0-9_. -]{1,80}\\s*\\(${nativeRolePattern}\\)`, "gi"));
  return { text: current, removed };
}

function nativeDisplayLabelsFromContextText(text) {
  const source = safeString(text);
  const labels = new Set();
  const nativeRolePattern = "(?:explore|debugger|verifier|test-engineer|critic|code-reviewer|architect|researcher|executor|dependency-expert|default)";
  const patterns = [
    /"(?:nickname|agent_nickname)"\s*:\s*"([^"\n\r]{1,160})"/gi,
    /'(?:nickname|agent_nickname)'\s*:\s*'([^'\n\r]{1,160})'/gi,
    /\\+"(?:nickname|agent_nickname)\\+"\s*:\s*\\+"([^"\\\n\r]{1,160})\\+"/gi,
    /\b(?:nickname|agent_nickname)=([^\s,|)]{1,160})/gi,
    new RegExp(`(?:正在关闭|无法关闭|已关闭|关闭失败|创建中|已创建|创建失败)[^\\n\\r]{0,220}?\\b([A-Z][A-Za-z0-9_. -]{1,80})\\s*\\(${nativeRolePattern}\\)`, "gi"),
    new RegExp(`\\b(?:closing|closed|close failed|creating|created|spawn failed)\\b[^\\n\\r]{0,220}?\\b([A-Z][A-Za-z0-9_. -]{1,80})\\s*\\(${nativeRolePattern}\\)`, "gi"),
    /(^|\\n|\\r|[^A-Za-z])([A-Z][A-Za-z0-9_. -]{1,80})\s+(?:review\b|在审|还没返回|已关闭|返回了|查|的[^\\\n\r]{0,60}?返回)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = safeString(match[2] ?? match[1]).trim();
      if (value.length < 3) continue;
      if (/^(?:agent|default|explore|debugger|critic|reviewer|worker|current|review|code|test|archived-[0-9a-f]{8})$/i.test(value)) continue;
      labels.add(value);
    }
  }
  return [...labels];
}

function scrubNativeDisplayLabelsFromText(text, labels) {
  let current = safeString(text);
  let removed = 0;
  for (const label of labels ?? []) {
    const value = safeString(label).trim();
    if (value.length < 3) continue;
    const pattern = new RegExp(`\\b${escapeRegExpLiteral(value)}\\b`, "g");
    const matches = current.match(pattern);
    if (!matches) continue;
    removed += matches.length;
    current = current.replace(pattern, "[archived-child]");
  }
  return { text: current, removed };
}

function scrubHistoricalNativeAgentIdContextText(text) {
  let current = safeString(text);
  let removed = 0;
  const placeholder = "[removed-native-agent-id]";
  const replaceValue = (pattern) => {
    current = current.replace(pattern, (...args) => {
      const groups = args.at(-1);
      removed += 1;
      if (groups && typeof groups === "object" && Object.hasOwn(groups, "prefix")) {
        return `${groups.prefix}${placeholder}${groups.suffix ?? ""}`;
      }
      return placeholder;
    });
  };
  const idKeys = "agent_id|child_thread_id|close_target_id";
  replaceValue(new RegExp(`(?<prefix>"(?:${idKeys})"\\s*:\\s*")(?<value>[^"\\n\\r]{1,180})(?<suffix>")`, "gi"));
  replaceValue(new RegExp(`(?<prefix>'(?:${idKeys})'\\s*:\\s*')(?<value>[^'\\n\\r]{1,180})(?<suffix>')`, "gi"));
  replaceValue(new RegExp(`(?<prefix>\\\\+"(?:${idKeys})\\\\+"\\s*:\\s*\\\\+")(?<value>[^"\\\\\\n\\r]{1,180})(?<suffix>\\\\+")`, "gi"));
  replaceValue(new RegExp(`(?<prefix>\\b(?:${idKeys})=)(?<value>[^\\s,|)]{1,180})`, "gi"));
  return { text: current, removed };
}

function scrubNativeDisplayContextText(text) {
  let current = safeString(text);
  let removed = 0;
  const displayLabels = nativeDisplayLabelsFromContextText(current);
  const bareLabelScrub = scrubNativeDisplayLabelsFromText(current, displayLabels);
  current = bareLabelScrub.text;
  removed += bareLabelScrub.removed;
  const displayScrub = scrubNativeDisplayNameContextText(current);
  current = displayScrub.text;
  removed += displayScrub.removed;
  const historicalIdScrub = scrubHistoricalNativeAgentIdContextText(current);
  current = historicalIdScrub.text;
  removed += historicalIdScrub.removed;
  const removedLabelScrub = scrubRemovedNativeDisplayLabelText(current);
  current = removedLabelScrub.text;
  removed += removedLabelScrub.removed;
  return { text: current, removed };
}

function scrubPromptHistoryNativeAgentStatusText(text) {
  let current = safeString(text);
  let removed = 0;
  const placeholder = "[removed-native-agent-status]";
  const nativeRolePattern = "(?:explore|debugger|verifier|test-engineer|critic|code-reviewer|architect|researcher|executor|dependency-expert|default)";
  const replace = (pattern) => {
    current = current.replace(pattern, () => {
      removed += 1;
      return placeholder;
    });
  };
  replace(new RegExp(`(?:正在关闭|无法关闭|已关闭|关闭失败|创建中|已创建|创建失败)\\s*(?:(?:正在关闭|无法关闭|已关闭|关闭失败|创建中|已创建|创建失败)\\s*)?\\d+\\s*个智能体(?:[^\\n\\r]{0,220}?\\s+[^\\n\\r"'\\\`{}[\\]]+?\\s*\\(${nativeRolePattern}\\))?`, "gi"));
  replace(new RegExp(`\\b(?:closing|closed|close failed|creating|created|spawn failed)\\b[^\\n\\r]{0,220}?\\s+[^\\n\\r"'\\\`{}[\\]]+?\\s*\\(${nativeRolePattern}\\)`, "gi"));
  replace(new RegExp(`\\bThe\\s+(?:verifier|reviewer|critic|debugger|explorer|agent|sidecar)\\b[^\\n\\r]{0,320}\\bclosing\\s+it\\s+now\\b[^\\n\\r]{0,320}`, "gi"));
  replace(/\bI(?:'m| am)\s+closing\s+it\s+now\b[^\n\r]{0,320}/gi);
  replace(/\bclosing\s+it\s+now\s+rather\s+than\s+holding\b[^\n\r]{0,320}/gi);
  replace(new RegExp(`(?:已使用以下指令创建|使用以下指令创建)\\s+\\[archived-child\\]\\s*\\(${nativeRolePattern}\\)`, "gi"));
  replace(new RegExp(`\\[archived-child\\]\\s*\\(${nativeRolePattern}\\)`, "gi"));
  return { text: current, removed };
}

function scrubCodexGlobalStateNativeStatusObject(value) {
  let removed = 0;
  const scrubEntry = (entry) => {
    let text = safeString(entry);
    const displayScrub = scrubNativeDisplayContextText(text);
    text = displayScrub.text;
    removed += displayScrub.removed;
    const statusScrub = scrubPromptHistoryNativeAgentStatusText(text);
    text = statusScrub.text;
    removed += statusScrub.removed;
    return text;
  };
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (typeof node[index] === "string") {
          node[index] = scrubEntry(node[index]);
        } else {
          walk(node[index]);
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === "string") {
        node[key] = scrubEntry(child);
      } else {
        walk(child);
      }
    }
  };
  walk(value);
  return { value, removed };
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

function sqliteChangedCount(stdout) {
  const rows = parseSqliteJsonOutput(stdout);
  for (const row of Array.isArray(rows) ? rows.slice().reverse() : []) {
    const changed = Number(row?.changed ?? row?.["changes()"] ?? row?.["changes"]);
    if (Number.isFinite(changed)) return changed;
  }
  return 0;
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
      await archiveNativeChildThreadIds(repairableIds, "edge_close_repair");
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

async function repairClosedNativeEdgeRefs(parentThreadId, refs) {
  const targets = [...(refs ?? [])]
    .map((ref) => safeString(ref).trim())
    .filter(Boolean)
    .slice(0, NATIVE_EDGE_REPAIR_BATCH);
  const parentId = safeString(parentThreadId).trim();
  if (targets.length === 0 || !parentId) return new Set();
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return new Set();

  return await repairClosedNativeEdgeIds(parentId, targets);
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
    const changed = sqliteChangedCount(stdout);
    if (changed <= 0) return new Map();

    const repaired = new Map(uniquePairs);
    await archiveNativeChildThreadIds(repaired.keys(), "unique_child_not_found_repair");
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

function archivedThreadSetParts(threadColumns) {
  const parts = ["archived=1"];
  if (threadColumns.has("title") && threadColumns.has("agent_nickname")) {
    parts.push("title=case when title=agent_nickname then 'archived child ' || substr(id,1,8) else title end");
  }
  if (threadColumns.has("agent_nickname")) {
    parts.push("agent_nickname='archived-' || substr(id,1,8)");
  }
  if (threadColumns.has("source")) {
    parts.push("source=case when json_valid(source) and json_extract(source,'$.subagent.thread_spawn.agent_nickname') is not null then json_set(source,'$.subagent.thread_spawn.agent_nickname','archived-' || substr(id,1,8)) else source end");
  }
  if (threadColumns.has("archived_at")) {
    parts.push("archived_at=coalesce(archived_at, cast(strftime('%s','now') as integer))");
  }
  return parts;
}

async function archiveNativeChildThreadIds(childIds, reason = "closed_edge") {
  const ids = [...(childIds ?? [])].map((id) => safeString(id).trim()).filter(Boolean).slice(0, NATIVE_EDGE_REPAIR_BATCH);
  if (ids.length === 0) return 0;
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;

  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("archived")) return 0;
  const setParts = archivedThreadSetParts(threadColumns);

  const sql = [
    "pragma busy_timeout=250;",
    "update threads",
    `set ${setParts.join(", ")}`,
    "where coalesce(archived,0)=0",
    `and id in (${ids.map(sqlString).join(",")})`,
    "and id not in (select child_thread_id from thread_spawn_edges where status='open');",
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(stdout);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_child_thread_archive",
        reason,
        requested: ids.length,
        changed,
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
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

async function applyStaleCloseRequestEvidence(parentThreadId, transcriptPool, nativeThreadEdges, nowMs) {
  const parentId = safeString(parentThreadId).trim();
  if (!parentId || !(transcriptPool?.closeRequested instanceof Map)) return 0;
  const ids = [];
  for (const [id, requestedAtMs] of transcriptPool.closeRequested.entries()) {
    if (!id || !Number.isFinite(requestedAtMs) || requestedAtMs <= 0) continue;
    if (nowMs - requestedAtMs < NATIVE_CLOSE_REQUEST_GRACE_MS) continue;
    if (nativeThreadEdges?.closed?.has(id)) continue;
    if (!(nativeThreadEdges?.active?.has(id) || nativeThreadEdges?.terminal?.has(id))) continue;
    ids.push(id);
    if (ids.length >= NATIVE_EDGE_REPAIR_BATCH) break;
  }
  if (ids.length === 0) return 0;

  const repairedIds = await repairClosedNativeEdgeIds(parentId, ids);
  for (const id of repairedIds) {
    nativeThreadEdges?.active?.delete(id);
    nativeThreadEdges?.terminal?.delete(id);
    nativeThreadEdges?.closed?.add(id);
  }
  if (repairedIds.size > 0) {
    await appendAdvisorLog({
      event: "native_edge_stale_close_request_repair",
      parent_thread_id: parentId,
      requested: ids.length,
      changed: repairedIds.size,
      grace_seconds: Math.floor(NATIVE_CLOSE_REQUEST_GRACE_MS / 1000),
    });
  }
  return repairedIds.size;
}

async function maintainNativePoolStorage(state, nowMs, nowIso) {
  const last = msFromIso(state.last_native_edge_maintenance_at);
  if (last && nowMs - last < NATIVE_EDGE_MAINTENANCE_TTL_MS) return;
  const unarchivedOpenThreads = await unarchiveOpenNativeEdgeThreads();
  const archivedClosedThreads = await archiveClosedNativeEdgeThreads();
  const archivedOrphanVisibleThreads = await archiveStaleOrphanVisibleNativeChildThreads(nowMs);
  const prunedClosedEdges = await pruneClosedNativeEdges(nowMs);
  state.last_native_edge_maintenance_at = nowIso;
  if (unarchivedOpenThreads > 0) {
    state.last_native_open_edge_unarchive_at = nowIso;
    state.last_native_open_edge_unarchive_count = unarchivedOpenThreads;
  }
  if (archivedClosedThreads > 0) {
    state.last_native_edge_closed_archive_at = nowIso;
    state.last_native_edge_closed_archive_count = archivedClosedThreads;
  }
  if (archivedOrphanVisibleThreads > 0) {
    state.last_native_orphan_visible_archive_at = nowIso;
    state.last_native_orphan_visible_archive_count = archivedOrphanVisibleThreads;
  }
  if (prunedClosedEdges > 0) {
    state.last_native_edge_closed_prune_at = nowIso;
    state.last_native_edge_closed_prune_count = prunedClosedEdges;
  }
}

async function sqliteTableColumns(dbPath, tableName) {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, `pragma table_info(${tableName});`], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    return new Set((Array.isArray(rows) ? rows : []).map((row) => safeString(row?.name).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function pruneClosedNativeEdges(nowMs) {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;

  const cutoffSeconds = Math.floor((nowMs - closedEdgeRetentionMs()) / 1000);
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  const hasArchivedAt = threadColumns.has("archived_at");
  const hasUpdatedAt = threadColumns.has("updated_at");
  const ageCondition = hasArchivedAt
    ? `(t.id is null or (coalesce(t.archived_at,0)>0 and t.archived_at<${cutoffSeconds}))`
    : hasUpdatedAt
    ? `(t.id is null or (coalesce(t.updated_at,0)>0 and t.updated_at<${cutoffSeconds}))`
    : "t.id is null";
  const sql = [
    "pragma busy_timeout=250;",
    "create index if not exists idx_thread_spawn_edges_status_child on thread_spawn_edges(status,child_thread_id);",
    "delete from thread_spawn_edges",
    "where child_thread_id in (",
    "select e.child_thread_id",
    "from thread_spawn_edges e",
    "left join threads t on t.id=e.child_thread_id",
    "where e.status='closed'",
    `and ${ageCondition}`,
    `limit ${NATIVE_EDGE_CLOSED_PRUNE_BATCH}`,
    ");",
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(stdout);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_closed_edge_prune",
        changed,
        cutoff_seconds: cutoffSeconds,
        retention_hours: Math.floor(closedEdgeRetentionMs() / (60 * 60 * 1000)),
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
  }
}

async function archiveClosedNativeEdgeThreads() {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("archived")) return 0;

  const setParts = archivedThreadSetParts(threadColumns);
  const sql = [
    "pragma busy_timeout=250;",
    "create index if not exists idx_thread_spawn_edges_status_child on thread_spawn_edges(status,child_thread_id);",
    "update threads",
    `set ${setParts.join(", ")}`,
    "where coalesce(archived,0)=0",
    "and id in (",
    "select child_thread_id from thread_spawn_edges",
    "where status='closed'",
    `limit ${NATIVE_EDGE_CLOSED_PRUNE_BATCH}`,
    ");",
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(stdout);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_closed_edge_thread_archive",
        changed,
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
  }
}

async function unarchiveOpenNativeEdgeThreads(parentThreadId = "") {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("archived")) return 0;

  const setParts = ["archived=0"];
  if (threadColumns.has("archived_at")) {
    setParts.push("archived_at=null");
  }
  const parentClause = parentThreadId
    ? `and e.parent_thread_id=${sqlString(parentThreadId)}`
    : "";
  const sql = [
    "pragma busy_timeout=250;",
    "create index if not exists idx_thread_spawn_edges_status_child on thread_spawn_edges(status,child_thread_id);",
    "update threads",
    `set ${setParts.join(", ")}`,
    "where coalesce(archived,0)=1",
    "and id in (",
    "select e.child_thread_id from thread_spawn_edges e",
    "where e.status='open'",
    parentClause,
    ");",
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(stdout);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_open_edge_thread_unarchive",
        parent_thread_id: parentThreadId || null,
        changed,
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
  }
}

async function archiveStaleOrphanVisibleNativeChildThreads(nowMs) {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("archived")) return 0;
  if (!threadColumns.has("source") && !threadColumns.has("thread_source")) return 0;

  const cutoffSeconds = Math.floor((nowMs - orphanVisibleRetentionMs()) / 1000);
  const hasArchivedAt = threadColumns.has("archived_at");
  const hasUpdatedAt = threadColumns.has("updated_at");
  const hasSource = threadColumns.has("source");
  const hasThreadSource = threadColumns.has("thread_source");
  const setParts = archivedThreadSetParts(threadColumns);
  const sourcePredicates = [];
  if (hasThreadSource) sourcePredicates.push("thread_source='subagent'");
  if (hasSource) sourcePredicates.push("source like '%\"parent_thread_id\"%'");
  const ageCondition = hasUpdatedAt ? `coalesce(updated_at,0)>0 and updated_at<${cutoffSeconds}` : "0";
  const sql = [
    "pragma busy_timeout=250;",
    "create index if not exists idx_thread_spawn_edges_status_child on thread_spawn_edges(status,child_thread_id);",
    "update threads",
    `set ${setParts.join(", ")}`,
    "where coalesce(archived,0)=0",
    `and (${sourcePredicates.join(" or ")})`,
    `and ${ageCondition}`,
    "and not exists (",
    "select 1 from thread_spawn_edges e",
    "where e.child_thread_id=threads.id",
    ");",
    "select changes() as changed;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(stdout);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "native_orphan_visible_thread_archive",
        changed,
        cutoff_seconds: cutoffSeconds,
        retention_hours: Math.floor(orphanVisibleRetentionMs() / (60 * 60 * 1000)),
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
  }
}

async function repairStaleOpenNativeEdges(parentThreadId, nowMs) {
  const retentionMs = staleOpenEdgeRetentionMs();
  const parentId = safeString(parentThreadId).trim();
  if (!parentId || retentionMs <= 0) return new Set();
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return new Set();

  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("updated_at")) return new Set();
  const cutoffSeconds = Math.floor((nowMs - retentionMs) / 1000);
  const selectSql = [
    "select e.child_thread_id",
    "from thread_spawn_edges e",
    "left join threads t on t.id=e.child_thread_id",
    "where e.status!='closed'",
    `and e.parent_thread_id=${sqlString(parentId)}`,
    "and coalesce(t.updated_at,0)>0",
    `and t.updated_at<${cutoffSeconds}`,
    "order by t.updated_at asc",
    `limit ${NATIVE_EDGE_REPAIR_BATCH};`,
  ].join(" ");

  try {
    const { stdout: selectStdout } = await execFileAsync("sqlite3", ["-json", dbPath, selectSql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(selectStdout);
    const ids = new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => safeString(row?.child_thread_id).trim())
        .filter(Boolean),
    );
    if (ids.size === 0) return ids;

    const sql = [
      "pragma busy_timeout=250;",
      "update thread_spawn_edges",
      "set status='closed'",
      "where status!='closed'",
      `and parent_thread_id=${sqlString(parentId)}`,
      `and child_thread_id in (${[...ids].map(sqlString).join(",")});`,
      "select changes() as changed;",
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(stdout);
    if (changed <= 0) return new Set();
    await archiveNativeChildThreadIds(ids, "stale_open_edge_repair");
    await appendAdvisorLog({
      event: "native_stale_open_edge_repair",
      parent_thread_id: parentId,
      changed,
      cutoff_seconds: cutoffSeconds,
      retention_hours: Math.floor(retentionMs / (60 * 60 * 1000)),
    });
    return ids;
  } catch {
    return new Set();
  }
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

  const staleOpenRepaired = await repairStaleOpenNativeEdges(parentThreadId, Date.now());
  edges.repaired += staleOpenRepaired.size;
  await unarchiveOpenNativeEdgeThreads(parentThreadId);

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
    for (const row of rows) {
      const childId = safeString(row?.child_thread_id).trim();
      if (!childId) continue;
      edges.lanes.set(childId, {
        id: childId,
        parent_thread_id: parentThreadId,
        role: compactOneLine(row?.agent_role, 32),
        model: compactOneLine(row?.model, 48),
        reasoning_effort: compactOneLine(row?.reasoning_effort, 16),
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
    if (edges.closed.size > 0) {
      edges.visible_archived += await archiveNativeChildThreadIds(edges.closed, "closed_edge_current_parent_sample");
    }
    await discoverVisibleNativeChildThreads(parentThreadId, edges);
  } catch {
    edges.failed = true;
  }

  return edges;
}

async function nonOpenCurrentParentChildIds(parentThreadId) {
  return new Set((await nonOpenCurrentParentChildRefs(parentThreadId)).map((ref) => ref.id).filter(Boolean));
}

async function nonOpenCurrentParentChildRefs(parentThreadId) {
  const parentId = safeString(parentThreadId).trim();
  if (!parentId) return [];
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return [];
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  const archivedExpr = threadColumns.has("archived") ? "coalesce(t.archived,0)" : "0";
  const titleExpr = threadColumns.has("title") ? "t.title" : "null";
  const nicknameExpr = threadColumns.has("agent_nickname") ? "t.agent_nickname" : "null";
  const sourceTitleExpr = threadColumns.has("title") ? "title" : "null";
  const sourceNicknameExpr = threadColumns.has("agent_nickname") ? "agent_nickname" : "null";
  const edgeSql = [
    `select e.child_thread_id,${titleExpr} as title,${nicknameExpr} as nickname`,
    "from thread_spawn_edges e",
    "left join threads t on t.id=e.child_thread_id",
    `where e.parent_thread_id=${sqlString(parentId)}`,
    `and (e.status!='open' or ${archivedExpr}=1)`,
    `limit ${NATIVE_EDGE_REPAIR_BATCH};`,
  ].join(" ");
  const sourceSql = threadColumns.has("source") && threadColumns.has("archived")
    ? [
      `select id,source,${sourceTitleExpr} as title,${sourceNicknameExpr} as nickname`,
      "from threads",
      "where coalesce(archived,0)=1",
      "and source like '%\"parent_thread_id\"%'",
      `and source like ${sqlString(`%${parentId}%`)}`,
      `limit ${NATIVE_EDGE_REPAIR_BATCH};`,
    ].join(" ")
    : "";

  const refs = new Map();
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, edgeSql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const edgeRows = parseSqliteJsonOutput(stdout);
    for (const row of Array.isArray(edgeRows) ? edgeRows : []) {
      const id = safeString(row?.child_thread_id).trim();
      if (!id) continue;
      refs.set(id, {
        id,
        title: safeString(row?.title).trim(),
        nickname: safeString(row?.nickname).trim(),
      });
    }
  } catch {
    // Keep archived-source fallback available when edge sampling is temporarily unavailable.
  }

  if (sourceSql) {
    try {
      const { stdout: sourceStdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sourceSql], {
        timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
        maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
      });
      const sourceRows = parseSqliteJsonOutput(sourceStdout);
      for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
        if (parentThreadIdFromSourceText(row?.source) !== parentId) continue;
        const id = safeString(row?.id).trim();
        if (!id) continue;
        refs.set(id, {
          id,
          title: safeString(row?.title).trim(),
          nickname: safeString(row?.nickname).trim(),
        });
      }
    } catch {
      // Edge rows, if present, are still useful.
    }
  }
  return [...refs.values()];
}

async function nonOpenVisibleChildRefs(limit = 500) {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return [];
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("id")) return [];
  const archivedExpr = threadColumns.has("archived") ? "coalesce(t.archived,0)" : "0";
  const titleExpr = threadColumns.has("title") ? "t.title" : "null";
  const nicknameExpr = threadColumns.has("agent_nickname") ? "t.agent_nickname" : "null";
  const sql = [
    `select t.id,${titleExpr} as title,${nicknameExpr} as nickname`,
    "from threads t",
    "left join thread_spawn_edges e on e.child_thread_id=t.id",
    `where (${archivedExpr}=1 or e.status='closed')`,
    "order by coalesce(t.updated_at,0) desc",
    `limit ${Math.max(1, Math.min(1000, Math.floor(Number(limit) || 500)))};`,
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        id: safeString(row?.id).trim(),
        title: safeString(row?.title).trim(),
        nickname: safeString(row?.nickname).trim(),
      }))
      .filter((ref) => ref.id);
  } catch {
    return [];
  }
}

function transcriptMentionedChildIdPrefixes(text) {
  const source = safeString(text);
  const values = new Set();
  for (const match of source.matchAll(/\b019[0-9a-f]{5}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi)) {
    values.add(match[0]);
  }
  for (const match of source.matchAll(/\b019[0-9a-f]{5}\b/gi)) {
    values.add(`${match[0]}%`);
  }
  return [...values].slice(0, TRANSCRIPT_MENTIONED_CHILD_REF_QUERY_LIMIT);
}

async function nonOpenMentionedChildRefs(text) {
  const idPatterns = transcriptMentionedChildIdPrefixes(text);
  if (idPatterns.length === 0) return [];
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return [];
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("id")) return [];
  const archivedExpr = threadColumns.has("archived") ? "coalesce(t.archived,0)" : "0";
  const titleExpr = threadColumns.has("title") ? "t.title" : "null";
  const nicknameExpr = threadColumns.has("agent_nickname") ? "t.agent_nickname" : "null";
  const predicates = idPatterns.map((value) => value.endsWith("%")
    ? `t.id like ${sqlString(value)}`
    : `t.id=${sqlString(value)}`);
  const sql = [
    `select t.id,${titleExpr} as title,${nicknameExpr} as nickname,${archivedExpr} as archived,coalesce(e.status,'') as edge_status`,
    "from threads t",
    "left join thread_spawn_edges e on e.child_thread_id=t.id",
    `where (${predicates.join(" or ")})`,
    `and (${archivedExpr}=1 or e.status='closed')`,
    `limit ${NATIVE_EDGE_REPAIR_BATCH};`,
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        id: safeString(row?.id).trim(),
        title: safeString(row?.title).trim(),
        nickname: safeString(row?.nickname).trim(),
      }))
      .filter((ref) => ref.id);
  } catch {
    return [];
  }
}

function mergeChildRefs(...groups) {
  const refs = new Map();
  for (const group of groups) {
    for (const ref of Array.isArray(group) ? group : []) {
      const id = safeString(ref?.id).trim();
      if (!id || refs.has(id)) continue;
      refs.set(id, {
        id,
        title: safeString(ref?.title).trim(),
        nickname: safeString(ref?.nickname).trim(),
      });
    }
  }
  return [...refs.values()];
}

async function sanitizeTranscriptSubagentContext(transcript, parentThreadId, reason = "maintenance") {
  const path = safeString(transcript).trim();
  if (!path || !safeString(parentThreadId).trim()) return 0;

  try {
    const stats = await stat(path);
    if (stats.size > TRANSCRIPT_SUBAGENT_CONTEXT_SANITIZE_MAX_BYTES) {
      await appendAdvisorLog({
        event: "transcript_subagent_context_sanitize_skipped",
        reason: "file_too_large",
        transcript: path,
        size: stats.size,
      });
      return 0;
    }

    let text = await readFile(path, "utf-8");
    let removed = 0;
    const displayScrub = scrubNativeDisplayNameContextText(text);
    text = displayScrub.text;
    removed += displayScrub.removed;
    const historicalIdScrub = scrubHistoricalNativeAgentIdContextText(text);
    text = historicalIdScrub.text;
    removed += historicalIdScrub.removed;
    const staleRefs = mergeChildRefs(
      await nonOpenCurrentParentChildRefs(parentThreadId),
      await nonOpenMentionedChildRefs(text),
    );
    for (const ref of staleRefs) {
      const lineResult = removeSubagentContextLine(text, ref.id);
      text = lineResult.text;
      removed += lineResult.removed;
      const scrubResult = scrubNonOpenChildReferenceText(text, ref);
      text = scrubResult.text;
      removed += scrubResult.removed;
    }
    if (removed <= 0) return 0;
    await writeFile(path, text, "utf-8");
    await appendAdvisorLog({
      event: "transcript_subagent_context_sanitize",
      reason,
      parent_thread_id: parentThreadId,
      removed,
    });
    return removed;
  } catch {
    return 0;
  }
}

function shouldSanitizeTranscriptSubagentContext(eventName, session, nowMs) {
  if (eventName === "PostCompact") return true;
  if (eventName !== "SessionStart" && eventName !== "UserPromptSubmit") return false;
  const lastMs = msFromIso(session?.last_subagent_context_sanitize_at);
  return !lastMs || nowMs - lastMs >= TRANSCRIPT_SUBAGENT_CONTEXT_SANITIZE_TTL_MS;
}

async function discoverVisibleNativeChildThreads(parentThreadId, edges) {
  const parentId = safeString(parentThreadId).trim();
  if (!parentId) return 0;
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("source") || !threadColumns.has("archived")) return 0;

  const sql = [
    "select id,title,agent_role,model,reasoning_effort,agent_nickname,cwd,updated_at,source",
    "from threads",
    "where coalesce(archived,0)=0",
    "and source like '%\"parent_thread_id\"%'",
    `and source like ${sqlString(`%${parentId}%`)}`,
    "order by coalesce(updated_at,0) desc",
    "limit 200;",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    edges.visible_checked = true;
    if (!Array.isArray(rows)) return 0;
    for (const row of rows) {
      if (parentThreadIdFromSourceText(row?.source) !== parentId) continue;
      const childId = safeString(row?.id).trim();
      if (!childId) continue;
      edges.visible.add(childId);
      if (!edges.lanes.has(childId)) {
        edges.lanes.set(childId, {
          id: childId,
          parent_thread_id: parentId,
          role: compactOneLine(row?.agent_role, 32),
          model: compactOneLine(row?.model, 48),
          reasoning_effort: compactOneLine(row?.reasoning_effort, 16),
          cwd: compactOneLine(row?.cwd, 72),
          updated_at: row?.updated_at,
        });
      }
    }
    return edges.visible.size;
  } catch {
    return 0;
  }
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

function mentionedThreadIds(text, limit = 16) {
  const raw = safeString(text);
  if (!raw) return [];
  const ids = [];
  const seen = new Set();
  const regex = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  for (const match of raw.matchAll(regex)) {
    const id = safeString(match[0]).trim();
    const normalized = id.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

async function lookupMentionedThreadIds(ids, currentParentId = "") {
  const targets = [...(ids ?? [])].map((id) => safeString(id).trim()).filter(Boolean).slice(0, 16);
  if (targets.length === 0) return [];
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) {
    return targets.map((id) => ({ id, found: false, status: "db_unavailable" }));
  }
  const parentId = safeString(currentParentId).trim();
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  const archivedExpr = threadColumns.has("archived") ? "coalesce(t.archived,0) as archived" : "0 as archived";
  const sql = [
    `select t.id,t.agent_role,t.model,${archivedExpr},e.parent_thread_id as edge_parent_thread_id,e.status as edge_status`,
    "from threads t",
    "left join thread_spawn_edges e on e.child_thread_id=t.id",
    `where t.id in (${targets.map(sqlString).join(",")})`,
    "order by t.updated_at desc,edge_status desc;",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    const byId = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = safeString(row?.id).trim();
      if (!id) continue;
      const item = {
        id,
        found: true,
        parent_thread_id: safeString(row?.edge_parent_thread_id ?? row?.parent_thread_id).trim(),
        status: safeString(row?.edge_status ?? row?.status).trim().toLowerCase() || "no_edge",
        archived: Number(row?.archived ?? 0) === 1,
        role: compactOneLine(row?.agent_role, 24),
        model: compactOneLine(row?.model, 36),
      };
      const current = byId.get(id);
      const itemIsCurrentOpen = parentId && item.parent_thread_id === parentId && item.status === "open" && !item.archived;
      const currentIsCurrentOpen = current
        && parentId
        && current.parent_thread_id === parentId
        && current.status === "open"
        && !current.archived;
      if (!current || (itemIsCurrentOpen && !currentIsCurrentOpen)) byId.set(id, item);
    }
    return targets.map((id) => byId.get(id) ?? { id, found: false, status: "unknown" });
  } catch {
    return targets.map((id) => ({ id, found: false, status: "db_query_failed" }));
  }
}

function buildMentionedThreadIdAudit(rows, currentParentId) {
  const parentId = safeString(currentParentId).trim();
  const warnings = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = safeString(row?.id).trim();
    if (!id) continue;
    const status = safeString(row?.status).trim().toLowerCase();
    const parent = safeString(row?.parent_thread_id).trim();
    const archived = Boolean(row?.archived);
    const found = Boolean(row?.found);
    const wrongParent = Boolean(parentId && parent && parent !== parentId);
    const notCurrentOpen = !found || archived || status !== "open" || wrongParent;
    if (!notCurrentOpen) continue;
    const details = [
      "id=[not-current-agent-id]",
      `status=${status || "unknown"}`,
      `archived=${archived ? "1" : "0"}`,
    ];
    if (parent) details.push(`parent=${wrongParent ? "[different-parent]" : "[current-parent]"}`);
    if (row?.role) details.push(`role=${compactOneLine(row.role, 24)}`);
    if (row?.model) details.push(`model=${compactOneLine(row.model, 36)}`);
    warnings.push(details.join(" "));
  }
  if (warnings.length === 0) return "";
  return [
    `MENTIONED_AGENT_ID_STATUS_AUDIT=${warnings.length}.`,
    warnings.map((item) => `MENTIONED_AGENT_ID_NOT_CURRENT(${item})`).join(" | "),
    "Do not close, reuse, or count these mentioned ids as current open lanes unless a fresh runtime close/list result proves they are active. Use the current parent/session capacity snapshot and LANES_OPEN inventory instead.",
  ].join(" ");
}

function promptLooksLikeQuotedCloseStatus(prompt) {
  const text = safeString(prompt);
  if (!text) return false;
  const normalized = text.toLowerCase();
  const hasCloseStatusVerb = /正在关闭|无法关闭|被关闭|关闭中|closing|being closed|close in progress/.test(normalized);
  if (!hasCloseStatusVerb) return false;
  const hasNativeAgentSurface = /智能体|agent|subagent|close_agent|spawn_agent|wait_agent/.test(normalized);
  const hasRoleLabel = /\((?:explore|debugger|verifier|test-engineer|critic|code-reviewer|architect|researcher|executor|dependency-expert|default)\)/i.test(text);
  const hasUiProgressCount = /正在关闭\s*\d+\s*个智能体/.test(text);
  return hasNativeAgentSurface || hasRoleLabel || hasUiProgressCount;
}

function removedNativeDisplayLabel() {
  return "[removed" + "-native-display-label]";
}

function scrubRemovedNativeDisplayLabelText(text) {
  const source = safeString(text);
  const needle = removedNativeDisplayLabel();
  const replacement = "[removed native close-status display label]";
  let current = source;
  let removed = 0;
  current = current.replace(/\\+\[removed native close-status display label\]/g, () => {
    removed += 1;
    return replacement;
  });
  current = current.replace(/\\+\[removed-native-display-label\]/g, () => {
    removed += 1;
    return replacement;
  });
  if (!current.includes(needle)) return { text: current, removed };
  const needleCount = current.split(needle).length - 1;
  return {
    text: current.split(needle).join(replacement),
    removed: removed + needleCount,
  };
}

function buildQuotedCloseStatusGuard(prompt, summary) {
  if (!promptLooksLikeQuotedCloseStatus(prompt)) return "";
  const candidates = closeCandidateTargets(summary);
  const candidateText = candidates.length > 0
    ? `CURRENT_PARENT_CLOSE_CANDIDATES=${candidates.join(",")}.`
    : "CURRENT_PARENT_CLOSE_CANDIDATES=none.";
  return [
    "QUOTED_CLOSE_STATUS_IS_NOT_AGENT_INVENTORY=true.",
    "The user prompt appears to quote or report a native close-status UI line; do not treat any quoted status text as current subagent inventory.",
    "Never derive a close_agent target from a quoted display name, nickname, title, role, or parenthesized label.",
    "Only an exact current-parent open thread id from fresh runtime/DB inventory is a valid close_agent target.",
    candidateText,
    candidates.length > 0
      ? "If capacity recovery is actually needed, close only listed current-parent completed_not_closed candidates by id, then resample."
      : "No current-parent completed_not_closed close candidate is listed; do not close anything based on the quoted status text.",
  ].join(" ");
}

async function sanitizeTranscriptRemovedNativeDisplayLabel(transcript, reason = "prompt_context") {
  const path = safeString(transcript).trim();
  if (!path) return 0;
  try {
    const stats = await stat(path);
    if (stats.size > TRANSCRIPT_SUBAGENT_CONTEXT_SANITIZE_MAX_BYTES) {
      return await sanitizeLargeNativeDisplayContextFile(path, stats, reason);
    }
    let text = await readFile(path, "utf-8");
    const scrub = scrubNativeDisplayContextText(text);
    text = scrub.text;
    const removed = scrub.removed;
    if (removed <= 0) return 0;
    await writeFile(path, text, "utf-8");
    await appendAdvisorLog({
      event: "removed_native_display_label_transcript_sanitize",
      reason,
      transcript: path,
      removed,
    });
    return removed;
  } catch {
    return 0;
  }
}

async function sanitizeLargeNativeDisplayContextFile(path, stats, reason = "prompt_context") {
  if (!path || !stats || stats.size > TRANSCRIPT_SUBAGENT_CONTEXT_STREAM_MAX_BYTES) return 0;
  if (!shouldStreamLargeTranscriptSanitize()) {
    await appendAdvisorLog({
      event: "large_transcript_native_display_sanitize_skipped",
      reason,
      transcript: path,
      bytes: stats.size,
      requires_env: "NATIVE_AGENT_POOL_FORCE_LARGE_TRANSCRIPT_SANITIZE=1",
    });
    return 0;
  }
  let tail = "";
  try {
    tail = await readFileTail(path, Math.min(TRANSCRIPT_TAIL_BYTES, stats.size));
  } catch {
    return 0;
  }
  if (scrubNativeDisplayContextText(tail).removed <= 0) return 0;

  const tmp = `${path}.native-display-sanitize.${process.pid}.${Date.now()}.tmp`;
  let removed = 0;
  let carry = "";
  const input = createReadStream(path, {
    encoding: "utf-8",
    highWaterMark: TRANSCRIPT_SANITIZE_STREAM_CHUNK_BYTES,
  });
  const output = createWriteStream(tmp, { encoding: "utf-8" });
  try {
    for await (const chunk of input) {
      const combined = `${carry}${chunk}`;
      const emitLength = Math.max(0, combined.length - TRANSCRIPT_SANITIZE_STREAM_OVERLAP_CHARS);
      const emit = combined.slice(0, emitLength);
      carry = combined.slice(emitLength);
      if (emit) {
        const scrub = scrubNativeDisplayContextText(emit);
        removed += scrub.removed;
        if (!output.write(scrub.text)) {
          await new Promise((resolve) => output.once("drain", resolve));
        }
      }
    }
    const finalScrub = scrubNativeDisplayContextText(carry);
    removed += finalScrub.removed;
    output.end(finalScrub.text);
    await finished(output);
    if (removed <= 0) {
      await rm(tmp, { force: true });
      return 0;
    }
    await rename(tmp, path);
    await appendAdvisorLog({
      event: "large_transcript_native_display_sanitize",
      reason,
      transcript: path,
      removed,
      bytes: stats.size,
    });
    return removed;
  } catch {
    try {
      output.destroy();
    } catch {
      // best effort
    }
    await rm(tmp, { force: true }).catch(() => {});
    return 0;
  }
}

async function sanitizeCodexGlobalStateNativeDisplayContext(parentThreadId = "", reason = "prompt_context") {
  const path = codexGlobalStatePath();
  try {
    if (!existsSync(path)) return 0;
    const stats = await stat(path);
    if (stats.size > GLOBAL_STATE_CONTEXT_SANITIZE_MAX_BYTES) return 0;
    let text = await readFile(path, "utf-8");
    let removed = 0;
    try {
      const parsed = JSON.parse(text);
      const nativeStatusScrub = scrubCodexGlobalStateNativeStatusObject(parsed);
      if (nativeStatusScrub.removed > 0) {
        text = JSON.stringify(nativeStatusScrub.value);
        removed += nativeStatusScrub.removed;
      }
    } catch {
      // Fall back to text scrubbing below for partially written state files.
    }
    const contextScrub = scrubNativeDisplayContextText(text);
    text = contextScrub.text;
    removed += contextScrub.removed;
    const staleRefs = mergeChildRefs(
      await nonOpenCurrentParentChildRefs(parentThreadId),
      await nonOpenVisibleChildRefs(),
    );
    for (const ref of staleRefs) {
      const lineResult = removeSubagentContextLine(text, ref.id);
      text = lineResult.text;
      removed += lineResult.removed;
      const scrubResult = scrubNonOpenChildReferenceText(text, ref);
      text = scrubResult.text;
      removed += scrubResult.removed;
    }
    if (removed <= 0) return 0;
    await writeFile(path, text, "utf-8");
    await appendAdvisorLog({
      event: "codex_global_state_native_display_sanitize",
      reason,
      removed,
    });
    return removed;
  } catch {
    return 0;
  }
}

async function sanitizeQuotedCloseStatusThreadTitle(threadId, reason = "quoted_close_status") {
  const id = safeString(threadId).trim();
  if (!id) return 0;
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return 0;
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  if (!threadColumns.has("id") || !threadColumns.has("title")) return 0;
  const selectSql = `select title from threads where id=${sqlString(id)} limit 1;`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, selectSql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const title = safeString(parseSqliteJsonOutput(stdout)?.[0]?.title);
    if (!promptLooksLikeQuotedCloseStatus(title)) return 0;
    const safeTitle = "Native subagent close-status contamination repair";
    const updateSql = [
      "pragma busy_timeout=250;",
      "update threads",
      `set title=${sqlString(safeTitle)}`,
      `where id=${sqlString(id)}`,
      "and title is not null;",
      "select changes() as changed;",
    ].join(" ");
    const { stdout: updateStdout } = await execFileAsync("sqlite3", ["-json", dbPath, updateSql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const changed = sqliteChangedCount(updateStdout);
    if (changed > 0) {
      await appendAdvisorLog({
        event: "quoted_close_status_thread_title_sanitize",
        reason,
        thread_id: id,
        changed,
      });
    }
    return Number.isFinite(changed) ? changed : 0;
  } catch {
    return 0;
  }
}

async function lookupCloseTargetRefs(refs, currentParentId) {
  const targets = [...(refs ?? [])]
    .map((ref) => safeString(ref).trim())
    .filter(Boolean)
    .slice(0, 16);
  if (targets.length === 0) return [];
  const parentId = safeString(currentParentId).trim();
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) {
    return targets.map((ref) => ({ ref, allowed: false, reason: "db_unavailable" }));
  }
  const threadColumns = await sqliteTableColumns(dbPath, "threads");
  const archivedExpr = threadColumns.has("archived") ? "coalesce(t.archived,0) as archived" : "0 as archived";
  const targetSql = targets.map(sqlString).join(",");
  const sql = [
    `select t.id,t.agent_nickname,t.title,t.agent_role,t.model,${archivedExpr},e.parent_thread_id as edge_parent_thread_id,e.status as edge_status`,
    "from threads t",
    "left join thread_spawn_edges e on e.child_thread_id=t.id",
    `where t.id in (${targetSql}) or t.agent_nickname in (${targetSql}) or t.title in (${targetSql})`,
    "order by t.updated_at desc,edge_status desc;",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: NATIVE_EDGE_QUERY_TIMEOUT_MS,
      maxBuffer: NATIVE_EDGE_QUERY_MAX_BUFFER,
    });
    const rows = parseSqliteJsonOutput(stdout);
    return targets.map((ref) => {
      const text = safeString(ref).trim();
      const matches = (Array.isArray(rows) ? rows : []).filter((row) => {
        return text === safeString(row?.id).trim()
          || text === safeString(row?.agent_nickname).trim()
          || text === safeString(row?.title).trim();
      });
      const currentOpen = matches.find((row) => {
        return safeString(row?.edge_parent_thread_id).trim() === parentId
          && safeString(row?.edge_status).trim().toLowerCase() === "open"
          && Number(row?.archived ?? 0) !== 1;
      });
      const exactIdMatch = Boolean(currentOpen && text === safeString(currentOpen?.id).trim());
      if (exactIdMatch) {
        return {
          ref,
          allowed: true,
          id: safeString(currentOpen?.id).trim(),
          role: compactOneLine(currentOpen?.agent_role, 24),
          model: compactOneLine(currentOpen?.model, 36),
        };
      }
      const row = matches[0];
      if (!row) return { ref, allowed: false, reason: "unknown" };
      return {
        ref,
        allowed: false,
        reason: currentOpen ? "display_ref_not_agent_id" : "not_current_open",
        id: safeString(row?.id).trim(),
        parent_thread_id: safeString(row?.edge_parent_thread_id).trim(),
        status: safeString(row?.edge_status).trim().toLowerCase() || "no_edge",
        archived: Number(row?.archived ?? 0) === 1,
        role: compactOneLine(row?.agent_role, 24),
        model: compactOneLine(row?.model, 36),
      };
    });
  } catch {
    return targets.map((ref) => ({ ref, allowed: false, reason: "db_query_failed" }));
  }
}

function refForCloseGuard(ref) {
  const text = safeString(ref).trim();
  if (!text) return "ref=empty";
  if (mentionedThreadIds(text, 1).length > 0) return `id=${compactOneLine(text, 42)}`;
  return "ref_type=name";
}

function buildCloseTargetGuard(eventName, rows, summary) {
  if (eventName !== "PreToolUse") return null;
  const violations = (Array.isArray(rows) ? rows : []).filter((row) => !row?.allowed);
  if (violations.length === 0) return null;
  const blocked = violations.map((row) => {
    const details = [
      refForCloseGuard(row?.ref),
      `reason=${safeString(row?.reason).trim() || "not_current_open"}`,
    ];
    if (row?.id) details.push(`matched_id=${compactOneLine(row.id, 42)}`);
    if (row?.status) details.push(`status=${safeString(row.status).trim()}`);
    if (row?.archived !== undefined) details.push(`archived=${row.archived ? "1" : "0"}`);
    if (row?.parent_thread_id) details.push(`parent=${compactOneLine(row.parent_thread_id, 42)}`);
    if (row?.role) details.push(`role=${compactOneLine(row.role, 24)}`);
    if (row?.model) details.push(`model=${compactOneLine(row.model, 36)}`);
    return `BLOCKED_CLOSE_TARGET(${details.join(" ")})`;
  });
  const candidates = closeCandidateTargets(summary);
  const candidateText = candidates.length > 0
    ? `CURRENT_PARENT_CLOSE_CANDIDATES=${candidates.join(",")}.`
    : "CURRENT_PARENT_CLOSE_CANDIDATES=none.";
  const context = [
    "Native agent close guard: close_agent target is not a current-parent open lane.",
    blocked.join(" | "),
    candidateText,
    "If a BLOCKED_CLOSE_TARGET includes matched_id, the only admissible retry target is that exact matched_id value, never the display name, nickname, title, role, or any parenthesized label.",
    "Do not retry this close target. Close only listed current-parent completed_not_closed candidates when capacity recovery is actually needed; otherwise keep useful active lanes and spawn within observed_free.",
  ].join(" ");
  return {
    decision: "block",
    reason: context,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function nativePoolResetMs(state, poolThreadId = "") {
  const globalResetMs = msFromIso(state?.last_native_pool_reset_at);
  const threadResetMs = poolThreadId
    ? msFromIso(safeString(state?.native_pool_reset_threads?.[poolThreadId]))
    : 0;
  return Math.max(globalResetMs, threadResetMs);
}

async function collectPoolEvidence(identity, nowMs, resetAtMs = 0, cap = DEFAULT_AGENT_CAP, options = {}) {
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
  if (options.reconcile !== false) {
    await applyMissingCloseEvidence(poolThreadId, transcriptPool, nativeThreadEdges);
    await applyStaleCloseRequestEvidence(poolThreadId, transcriptPool, nativeThreadEdges, nowMs);
  }
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
  // Native spawn does not reliably emit a correlated PostToolUse event. A
  // PreToolUse reservation therefore cannot outlive that one callback safely.
  // Keep the field only to migrate older state files; never admit against it.
  void nowMs;
  session.spawn_reservations = {};
}

function pruneAdvisorSessions(state, nowMs) {
  for (const [key, session] of Object.entries(state.sessions ?? {})) {
    if (!session || typeof session !== "object") {
      delete state.sessions[key];
      continue;
    }
    // Migrate every historical session at once so an old reservation cannot
    // become admission input again if that session is resumed later.
    session.spawn_reservations = {};
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

function hasForkContextRoleConflictInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (!operationForkContext(operation)) return false;
    return Boolean(operationAgentRole(operation));
  });
}

function hasForkContextInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    return operationForkContext(operation);
  });
}

function hasMissingSpawnModelInOperations(operations) {
  return operations.some((operation) => {
    if (operation.name !== "spawn_agent") return false;
    if (operationForkContext(operation)) return false;
    return !operationModel(operation);
  });
}

function unsupportedSubagentModelViolations(operations) {
  const supported = new Set(supportedSubagentModels().map((model) => model.toLowerCase()));
  return operations.filter((operation) => {
    if (operation.name !== "spawn_agent" || operationForkContext(operation)) return false;
    const model = operationModel(operation).toLowerCase();
    return Boolean(model) && !supported.has(model);
  });
}

function hasUnsupportedSubagentModelInOperations(operations) {
  return unsupportedSubagentModelViolations(operations).length > 0;
}

function unsupportedAgentTypeViolations(operations) {
  const allowed = new Set(allowedAgentTypes());
  if (allowed.size === 0) return [];
  return operations.filter((operation) => {
    if (operation.name !== "spawn_agent") return false;
    const role = operationAgentRole(operation);
    if (!role) return false;
    return !allowed.has(role);
  });
}

function hasUnsupportedAgentTypeInOperations(operations) {
  return unsupportedAgentTypeViolations(operations).length > 0;
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

function toolSearchReturnedNativeAgentSchema(payload, name = "") {
  const normalizedName = safeString(name).trim().toLowerCase();
  const text = responseText(payload);
  if (!text) return false;
  const looksLikeToolSearch = /tool_search|tool-search|tool search|tool_search_output/i.test(normalizedName)
    || /"type"\s*:\s*"tool_search_output"|tool_search_output|multi_agent_v1|Tools for spawning and managing sub-agents/i.test(text);
  if (!looksLikeToolSearch) return false;
  return /spawn_agent/i.test(text)
    && /(?:inherited parent model is preferred|Spawned agents inherit your current model by default|Omit `?model`?|model overrides \(optional\)|model is optional|inherited default model)/i.test(text);
}

function buildToolSearchNativeAgentSchemaCorrection(eventName, summary = null, cap = DEFAULT_AGENT_CAP) {
  const contexts = [
    "TOOL_SEARCH_NATIVE_AGENT_SCHEMA_CORRECTION_REQUIRED=true. The previous tool_search result exposed generic native subagent metadata that conflicts with this local install. Treat tool_search text such as \"model optional\", \"inherited parent model is preferred\", or \"Spawned agents inherit your current model\" as non-authoritative for this session.",
    buildCompactSpawnShapeGuidance(),
    summary ? buildCapacityGuidance(eventName, cap, summary, { detailed: true }) : "",
  ];
  return buildPromptGuidanceOutput(eventName, contexts);
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

function collectCloseTargetRefsFromValue(value, refs = new Set()) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text && text.length <= 220 && !/[\r\n]/.test(text)) refs.add(text);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCloseTargetRefsFromValue(item, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectCloseTargetRefsFromValue(child, refs);
  }
  return refs;
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

function collectCloseTargetRefs(payload) {
  const input = toolInput(payload);
  const refs = new Set();
  collectCloseTargetRefsFromValue(input.target, refs);
  collectCloseTargetRefsFromValue(input.targets, refs);
  return [...refs];
}

function closeTargetRefsFromOperations(operations) {
  const refs = new Set();
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (operation?.name !== "close_agent") continue;
    collectCloseTargetRefsFromValue(operation?.input?.target, refs);
    collectCloseTargetRefsFromValue(operation?.input?.targets, refs);
  }
  return [...refs];
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
  return looksLikeNarrowSpawnIntentPrompt(prompt)
    || /(?:\bnative\s+(?:pool|cap|limit)\b|\bsubagent\s+(?:pool|cap|limit)\b|\bagent\s+(?:pool|cap|limit)\b|\bpool\b|\bcap\b|\blimit\b|上限|满池|名额|槽位)/i.test(normalized);
}

function looksLikeNegativeSpawnIntentPrompt(prompt) {
  const normalized = safeString(prompt).toLowerCase();
  return /(?:\bdo\s+not\s+(?:spawn|use|create|start|launch)\s+(?:native\s+)?(?:sub)?agents?\b|\bdon't\s+(?:spawn|use|create|start|launch)\s+(?:native\s+)?(?:sub)?agents?\b|\bno\s+(?:native\s+)?subagents?\b|\bno\s+child\s+agents?\b|\bwithout\s+(?:native\s+)?subagents?\b|不要(?:生成|启动|创建|使用|派发).{0,12}(?:子代理|智能体|代理)|不要.{0,12}(?:子代理|智能体|代理)|别(?:生成|启动|创建|使用|派发).{0,12}(?:子代理|智能体|代理))/i.test(normalized);
}

function looksLikeNarrowSpawnIntentPrompt(prompt) {
  if (looksLikeNegativeSpawnIntentPrompt(prompt)) return false;
  const normalized = safeString(prompt).toLowerCase();
  return /(?:\bspawn_agent\b|\bnative\s+(?:sub)?agents?\b|\bsubagents?\b|\bchild\s+agents?\b|\bspawn\s+(?:a\s+|one\s+|new\s+|another\s+)?(?:native\s+)?(?:sub)?agents?\b|\bstart\s+(?:a\s+|one\s+|new\s+|another\s+)?(?:native\s+)?(?:sub)?agents?\b|\blaunch\s+(?:a\s+|one\s+|new\s+|another\s+)?(?:native\s+)?(?:sub)?agents?\b|\bcreate\s+(?:a\s+|one\s+|new\s+|another\s+)?(?:native\s+)?(?:sub)?agents?\b|\b(?:open|run|dispatch)\s+(?:one|two|three|four|five|six|[1-6])\s+(?:bounded\s+|read-only\s+)?(?:native\s+)?(?:sub)?agents?\b|\b(?:new|another|one\s+more)\s+(?:explorer|reviewer|verifier|researcher|critic)\b|\btry\s+(?:a\s+|one\s+|new\s+|another\s+)?(?:explorer|reviewer|verifier|researcher|critic)\b|生成.{0,12}(?:子代理|智能体|代理|子任务|任务线|诊断线)|启动.{0,12}(?:子代理|智能体|代理|子任务|任务线|诊断线)|创建.{0,12}(?:子代理|智能体|代理|子任务|任务线|诊断线)|派发.{0,12}(?:子代理|智能体|代理|子任务|任务线|诊断线)|开.{0,12}(?:子代理|智能体|代理|子任务|任务线|诊断线|条线|条 lane|lane)|并行.{0,24}(?:子代理|智能体|代理|子任务|任务线|诊断线|条线|lane)|(?:两|二|三|四|五|六|2|3|4|5|6).{0,8}(?:条|个).{0,12}(?:子任务|任务线|诊断线|lane|线))/i.test(normalized);
}

function looksLikeSpawnIntentPrompt(prompt) {
  return looksLikeNarrowSpawnIntentPrompt(prompt);
}

function spawnCountFromToken(token) {
  const normalized = safeString(token).trim().toLowerCase();
  if (!normalized) return 0;
  const counts = new Map([
    ["1", 1], ["one", 1], ["a", 1], ["an", 1], ["一", 1], ["一个", 1], ["一条", 1],
    ["2", 2], ["two", 2], ["两", 2], ["两个", 2], ["两条", 2], ["二", 2], ["双", 2],
    ["3", 3], ["three", 3], ["三", 3], ["三个", 3], ["三条", 3],
    ["4", 4], ["four", 4], ["四", 4], ["四个", 4], ["四条", 4],
    ["5", 5], ["five", 5], ["五", 5], ["五个", 5], ["五条", 5],
    ["6", 6], ["six", 6], ["六", 6], ["六个", 6], ["六条", 6],
  ]);
  return counts.get(normalized) ?? 0;
}

function inferRequestedSpawnsFromPrompt(prompt) {
  const text = safeString(prompt);
  if (!looksLikeNarrowSpawnIntentPrompt(text)) return 0;
  const compact = text
    .replace(/\s+/g, " ")
    .replace(/\b(?:one|two|three|four|five|six|[1-6])\s+(?:existing|current)\s+(?:native\s+)?(?:sub)?agents?\b/giu, "existing agents");
  const countToken = String.raw`(?<count>一个|一条|1|one|一|两个|两条|2|two|两|二|双|三个|三条|3|three|三|四个|四条|4|four|四|五个|五条|5|five|五|六个|六条|6|six|六)`;
  const target = String.raw`(?:(?:native\s+)?(?:sub)?agents?|child\s+agents?|subtasks?|child\s+tasks?|lanes?|scouts?|reviewers?|verifiers?|critics?|explorers?|子代理|智能体|代理|子任务|任务线|诊断线|条线|线|lane)`;
  const patterns = [
    new RegExp(`${countToken}.{0,24}${target}`, "iu"),
    new RegExp(`(?:spawn|start|launch|create|open|run|dispatch|并行|生成|启动|创建|派发|开).{0,24}${countToken}.{0,24}${target}`, "iu"),
    new RegExp(`${countToken}.{0,16}(?:read-only|bounded|只读|并行).{0,24}${target}`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = compact.match(pattern);
    const count = spawnCountFromToken(match?.groups?.count);
    if (count > 0) return Math.min(count, DEFAULT_AGENT_CAP);
  }
  if (/(?:\banother\b|\bone\s+more\b|\bnew\s+(?:explorer|reviewer|verifier|researcher|critic|agent|subagent|lane)\b|再开|再启|再派|另开|一个|一条).{0,24}(?:agent|subagent|child|lane|子代理|智能体|代理|子任务|任务线|诊断线|线)?/iu.test(compact)) {
    return 1;
  }
  return 0;
}

function hasRecentCapacityPressure(session, nowMs) {
  const recentMs = 6 * 60 * 60 * 1000;
  const lastCapHit = msFromIso(session.last_cap_hit_at);
  const lastCloseFailed = msFromIso(session.last_close_failed_at);
  return (
    (lastCapHit > 0 && nowMs - lastCapHit < recentMs)
    || (lastCloseFailed > 0 && nowMs - lastCloseFailed < recentMs)
  );
}

function hasPromptCapacityPressure(summary) {
  return Boolean(
    summary
      && (
        summary.occupied > 0
        || summary.cap_hit_blocks_spawn
        || summary.failed_closes > 0
      ),
  );
}

function hasCriticalPromptCapacityPressure(summary, cap) {
  return Boolean(
    summary
      && (
        remainingSpawnBudget(summary, cap) <= warnRemaining()
        || summary.native_edge_failed
        || summary.cap_hit_blocks_spawn
        || summary.failed_closes > 0
        || (summary.native_edge_overflow ?? 0) > 0
      ),
  );
}

function shouldEmitCapacityGuidance(eventName, prompt, session, nowMs, isChildSession, promptSummary = null, cap = DEFAULT_AGENT_CAP) {
  if (isChildSession) return false;
  if (eventName === "SessionStart") {
    const criticalPressure = hasCriticalPromptCapacityPressure(promptSummary, cap);
    if (criticalPressure) return true;
    const last = msFromIso(session.last_capacity_session_guidance_at);
    return !last || nowMs - last > SESSION_CAPACITY_GUIDANCE_TTL_MS;
  }

  if (eventName !== "UserPromptSubmit") return false;
  const negativeSpawnIntent = looksLikeNegativeSpawnIntentPrompt(prompt);
  const narrowSpawnIntent = looksLikeNarrowSpawnIntentPrompt(prompt);
  const promptPressure = hasPromptCapacityPressure(promptSummary);
  const criticalPressure = hasCriticalPromptCapacityPressure(promptSummary, cap);
  if (criticalPressure) return true;
  if (negativeSpawnIntent && !promptPressure && !criticalPressure) return false;
  if (
    !looksLikeDelegationPrompt(prompt)
    && !hasRecentCapacityPressure(session, nowMs)
    && !promptPressure
  ) return false;

  if (narrowSpawnIntent) return true;
  if (hasLaneInventory(promptSummary)) return true;

  const signature = hashText(prompt.trim().toLowerCase());
  const last = msFromIso(session.last_capacity_prompt_guidance_at);
  if (last && nowMs - last < PROMPT_CAPACITY_GUIDANCE_TTL_MS) return false;
  if (session.last_capacity_prompt_signature === signature && last) return false;
  return true;
}

function shouldEmitPostToolCapacityRefresh(eventName, session, nowMs, isChildSession, summary = null, cap = DEFAULT_AGENT_CAP) {
  if (isChildSession) return false;
  if (eventName !== "PostToolUse") return false;
  if (!summary) return false;
  const hasPressure = Boolean(
    hasCriticalPromptCapacityPressure(summary, cap)
      || hasLaneInventory(summary)
      || (summary.native_edge_terminal_debt ?? summary.terminal ?? 0) > 0
  );
  if (!hasPressure) return false;
  const last = msFromIso(session.last_capacity_post_tool_guidance_at);
  return !last || nowMs - last > POST_TOOL_CAPACITY_GUIDANCE_TTL_MS;
}

function markCapacityGuidanceEmitted(eventName, prompt, session, nowIso) {
  if (eventName === "SessionStart") {
    session.last_capacity_session_guidance_at = nowIso;
    return;
  }
  if (eventName === "UserPromptSubmit") {
    session.last_capacity_prompt_guidance_at = nowIso;
    session.last_capacity_prompt_signature = hashText(prompt.trim().toLowerCase());
    return;
  }
  if (eventName === "PostToolUse") {
    session.last_capacity_post_tool_guidance_at = nowIso;
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
    close_needed_for_two: Math.max(0, 2 - observedFree),
    close_needed_for_three: Math.max(0, 3 - observedFree),
    runtime_reservation: false,
    batch_guarantee: false,
    guarantee_level: capacityGuaranteeLevel(summary),
    recommended_protocol: requested > 1
      ? (requested <= observedFree ? "bounded_batch_precheck_then_resample" : "reduce_batch_or_close_then_resample")
      : (observedFree > 0 ? "reuse_or_spawn_when_subagent_value_then_resample" : "reuse_close_or_local_until_capacity_refresh"),
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
    `close_needed_for_two=${snapshot.close_needed_for_two}`,
    `close_needed_for_three=${snapshot.close_needed_for_three}`,
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
    return `slot_open=${summary.native_edge_active ?? 0}, slot_terminal=${summary.native_edge_terminal ?? 0}, slot_estimate=${summary.native_edge_slot_occupied ?? summary.occupied}/${summary.native_edge_cap ?? "?"}, visible_unarchived=${summary.native_visible_unarchived ?? 0}, ledger_lag=${summary.native_edge_ledger_lag ?? 0}, db_open_edge_debt=${summary.native_edge_debt ?? 0}, open_edge_overflow=${summary.native_edge_overflow ?? 0}, authority=${authority}`;
  }
  return "not_checked";
}

function formatLaneSummary(lane) {
  const id = compactOneLine(lane?.id, 42) || "unknown";
  const parts = [`agent_id=${id}`];
  const role = compactOneLine(lane?.role, 24);
  const model = compactOneLine(lane?.model, 36);
  const effort = compactOneLine(lane?.reasoning_effort, 12);
  if (role) parts.push(`role=${role}`);
  if (model) parts.push(`model=${model}`);
  if (effort) parts.push(`effort=${effort}`);
  return parts.join(" ");
}

function formatLaneUpdatedAt(lane) {
  const updatedAt = Number(lane?.updated_at);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? new Date(updatedAt * 1000).toISOString() : "";
}

function formatLaneInventoryItem(lane, status) {
  const base = formatLaneSummary(lane);
  const details = [];
  const updated = formatLaneUpdatedAt(lane);
  if (status) details.push(`status=${status}`);
  if (updated) details.push(`updated_at=${updated}`);
  details.push(`close_target_id=${compactOneLine(lane?.id, 42) || "unknown"}`);
  return `${base} (${details.join(", ")})`;
}

function laneInventoryCounts(summary) {
  const activeLanes = Array.isArray(summary?.native_active_lanes) ? summary.native_active_lanes : [];
  const lanes = Array.isArray(summary?.native_terminal_lanes) ? summary.native_terminal_lanes : [];
  return { activeLanes, terminalLanes: lanes };
}

function hasLaneInventory(summary) {
  const { activeLanes, terminalLanes } = laneInventoryCounts(summary);
  return activeLanes.length > 0 || terminalLanes.length > 0;
}

function laneInventoryGuidance(summary) {
  const { activeLanes, terminalLanes } = laneInventoryCounts(summary);
  if (activeLanes.length === 0 && terminalLanes.length === 0) return "";
  const activeText = activeLanes.length > 0
    ? `LANES_OPEN=${activeLanes.length}: ${activeLanes.map((lane) => formatLaneInventoryItem(lane, "open")).join(" | ")}.`
    : "";
  const terminalText = terminalLanes.length > 0
    ? `LANES_COMPLETED_NOT_CLOSED=${terminalLanes.length}: ${terminalLanes.map((lane) => formatLaneInventoryItem(lane, "completed_not_closed")).join(" | ")}.`
    : "";
  const overflowText = (summary?.native_edge_overflow ?? 0) > 0
    ? `Native DB open-edge debt exceeds the ${summary.native_edge_cap ?? "configured"}-slot runtime cap: db_open_edge_debt=${summary.native_edge_debt}, open_edge_overflow=${summary.native_edge_overflow}. Overflow rows are repair debt, not additional live agents.`
    : "";
  const reuseText = "LANE_REUSE_CHECK_REQUIRED=true. Compare the intended task contract against this current-parent lane inventory before spawning. If a same-topic/same-domain active lane has compatible model and context, use send_input to reuse it. Positive observed_free means do not close a still-running, task-critical lane merely to make room; spawn within free capacity and resample. Completed_not_closed lanes are already finished but still consume native slots; when zero-budget/cap-pressure exists, close listed completed_not_closed lanes before retrying spawn.";
  return `${activeText} ${terminalText} ${reuseText} ${overflowText}`.trim();
}

function zeroBudgetRecoveryGuidance(summary) {
  const activeLanes = Array.isArray(summary?.native_active_lanes) ? summary.native_active_lanes : [];
  const terminalLanes = Array.isArray(summary?.native_terminal_lanes) ? summary.native_terminal_lanes : [];
  const hasListedLane = activeLanes.length > 0 || terminalLanes.length > 0;
  const candidateText = terminalLanes.length > 0
    ? "Close listed completed_not_closed lane(s) first before any new spawn; task_complete did not release their native slot, and these lanes are already complete."
    : activeLanes.length > 0
    ? "Only close an active lane when the leader knows it is no longer needed; otherwise reuse it or wait for it. Do not switch to local execution solely because the pool is full."
    : "No current-parent close target is listed; treat this as a state mismatch and verify hook/native DB state instead of retrying spawn.";
  return [
    "ZERO_BUDGET_RECOVERY_REQUIRED=true.",
    "Do not stop at saying the subagent pool is full.",
    terminalLanes.length > 0
      ? "Before any new spawn, close enough listed completed_not_closed current-parent lane(s) to satisfy close_needed_for_request/close_needed_for_one/two/three for the intended batch, then resample capacity. Completed_not_closed lanes are not unknown active work; they are completed safe close candidates."
      : "Before any new spawn, choose one recovery action: reuse a compatible current-parent lane with send_input, close listed current-parent lane(s) that are no longer needed, or wait for an active lane if its result is needed. Do not convert pool-full into a silent local-only plan.",
    candidateText,
    hasListedLane
      ? "After a successful close_agent or runtime not-found close repair, re-check capacity and use the refreshed observed_free snapshot before any new spawn batch."
      : "If live state says fewer lanes exist than the hook snapshot, run a fresh hook/live check and use the newer scoped budget."
  ].join(" ");
}

function closeCandidateTargets(summary) {
  const terminalLanes = Array.isArray(summary?.native_terminal_lanes) ? summary.native_terminal_lanes : [];
  const unreachable = new Set(Array.isArray(summary?.unreachable_close_targets) ? summary.unreachable_close_targets : []);
  return terminalLanes
    .filter((lane) => {
      const id = safeString(lane?.id).trim();
      return !unreachable.has(id);
    })
    .map((lane) => safeString(lane?.target ?? lane?.id).trim())
    .filter(Boolean)
    .sort();
}

function buildSpawnCapacityFailureRecovery(eventName, summary, cap) {
  const targets = closeCandidateTargets(summary);
  const targetText = targets.length > 0
    ? `CLOSE_CANDIDATES=${targets.join(",")}.`
    : "CLOSE_CANDIDATES=none_listed.";
  const actionText = targets.length > 0
    ? "Next action: close one or more listed completed_not_closed current-parent lane(s), then wait for the next hook capacity snapshot before retrying spawn_agent."
    : "Next action: no completed_not_closed close target was listed; reuse an existing lane or inspect current-parent native DB/runtime state before retrying spawn_agent.";
  const context = [
    "SPAWN_AGENT_FAILED_POOL_FULL_RECOVERY_REQUIRED=true.",
    `The last spawn_agent call hit the native thread limit for this parent/session; do not retry spawn_agent from the failed prompt.`,
    `current_parent_occupied=${summary.occupied}/${cap}.`,
    `completed_not_closed=${summary.native_edge_terminal_debt ?? summary.terminal}.`,
    `open_active=${summary.native_edge_active_debt ?? summary.running}.`,
    targetText,
    actionText,
    "Do not switch to local-only execution solely because the pool is full; recover capacity or reuse a compatible current-parent lane.",
    "task_complete does not free a slot; only successful close_agent or verified runtime not-found close repair does.",
  ].join(" ");
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function buildTurnBudgetGuidance(summary, cap, detailed = false, requestedSpawns = 0) {
  if (!summary) return "";
  const snapshot = capacitySnapshot(summary, cap, requestedSpawns);
  const zeroBudgetCloseTargets = closeCandidateTargets(summary);
  const zeroBudgetCloseText = zeroBudgetCloseTargets.length > 0
    ? `CLOSE_BEFORE_SPAWN_REQUIRED=true. COMPLETED_NOT_CLOSED_ARE_CLOSE_CANDIDATES=true. CLOSE_CANDIDATES=${zeroBudgetCloseTargets.join(",")}. Close enough listed completed_not_closed current-parent lane(s) before any spawn_agent call, then resample capacity. Do not call these lanes unknown; they have task_complete evidence and are the preferred safe close targets.`
    : "CLOSE_BEFORE_SPAWN_REQUIRED=false. CLOSE_CANDIDATES=none_listed. No completed_not_closed current-parent lane is listed; reuse a compatible lane, wait for needed active lane(s), or inspect current-parent native state before retrying spawn_agent.";
  const hardDirective = snapshot.observed_free === 0
    ? `SPAWN_AGENT_DISABLED_THIS_TURN=true (zero-budget observed snapshot). observed_free=0, remaining_spawn_budget=0, close_needed_for_one=${snapshot.close_needed_for_one}, close_needed_for_two=${snapshot.close_needed_for_two}, close_needed_for_three=${snapshot.close_needed_for_three}, close_needed_for_request=${snapshot.close_needed_for_request}: do not call spawn_agent from this capacity snapshot. ${zeroBudgetCloseText} Do not switch to local-only execution merely because the pool is full. After close_agent succeeds or runtime not-found close evidence appears, rely on the next hook/PreToolUse capacity check before spawning; do not keep treating this stale zero-budget message as current state.`
    : `SPAWN_AGENT_OBSERVED_FREE=${snapshot.observed_free}. MAX_SPAWN_BATCH_NOW=${snapshot.observed_free}. TWO_LANE_PLAN_ALLOWED=${snapshot.observed_free >= 2 ? "yes" : "no"}. THREE_LANE_PLAN_ALLOWED=${snapshot.observed_free >= 3 ? "yes" : "no"}. SPAWN_AGENT_DISABLED_THIS_TURN=false. SUBAGENTS_AVAILABLE_FOR_VALUEFUL_PARALLEL_WORK=true. BATCH_SPAWN_GUARANTEE=false. This is a positive observed snapshot, not an atomic runtime reservation. For subagent-relevant read-heavy, multi-slice, review, verification, or explicitly parallel work, do not say "I cannot/no subagents" from this snapshot; choose reuse or spawn with explicit model and bounded task contract unless the task is tiny, user-forbidden, or already fully evidenced locally. A same-tool spawn batch is admissible only when the immediate PreToolUse check sees requested_spawns<=observed_free. If intended_spawn_count is greater than MAX_SPAWN_BATCH_NOW, do not launch a partial batch and let the remainder hit thread limit; either reduce the batch to MAX_SPAWN_BATCH_NOW or close enough completed_not_closed lane(s) for the whole intended batch, resample, and only then spawn. If older context or another surface says capacity is 0, treat this positive observed_free snapshot as the current authority for this parent/session. Do not report native subagent capacity as 0 from this snapshot.`;
  const completedNotClosed = summary.native_edge_terminal_debt ?? summary.terminal;
  const snapshotLine = `Current parent/session native subagent capacity snapshot: occupied=${summary.occupied}/${cap}, ${formatCapacitySnapshot(snapshot)}, slot_pressure_source=${summary.slot_pressure_source}, native_slots=${nativeEdgeSummary(summary)}, completed_not_closed=${completedNotClosed}, cap_hit_after_last_close=${summary.cap_hit_after_last_close ? "yes" : "no"}, cap_hit_blocks_spawn=${summary.cap_hit_blocks_spawn ? "yes" : "no"}.`;
  const base = [
    hardDirective,
    snapshotLine,
    laneInventoryGuidance(summary),
  ];
  if (!detailed) return base.filter(Boolean).join(" ");
  return [
    ...base,
    snapshot.observed_free === 0 ? zeroBudgetRecoveryGuidance(summary) : "",
    "The hook has no Codex-internal atomic reservation API. observed_free/remaining_spawn_budget is a current scoped observation; PreToolUse can only precheck the current requested batch before the runtime executes it.",
    "wait_agent does not free a slot; close_agent frees a slot only after a successful close result or runtime not-found close evidence.",
    snapshot.observed_free === 0
      ? "When observed_free is 0, do not call spawn_agent. Reuse a compatible lane, close known no-longer-needed current-parent lane(s), or wait for needed active lane(s) first; send_input and wait_agent do not increase capacity. If close_agent succeeds, re-check capacity before any spawn because the older zero-budget snapshot is no longer authoritative."
      : "This is a positive-capacity snapshot. Do not report native subagent capacity as 0, say spawning is disabled, or decline useful subagents from this snapshot; only a later fresh hook/runtime cap-hit can supersede it.",
  ].filter(Boolean).join(" ");
}

function buildSubagentModelSelectionGuidance() {
  return [
    "NATIVE_SUBAGENT_USER_AUTHORIZATION_NOT_REQUIRED=true. The parent agent may use or reuse bounded native child agents for valuable independent work without a separate explicit user request, unless the user forbids delegation.",
    "LOCAL_NATIVE_AGENT_POLICY_OVERRIDES_TOOL_SCHEMA=true. Use/reuse native child agents for valuable independent bounded work when capacity allows, and make model routing explicit for every non-fork spawn.",
    "TOOL_SEARCH_NATIVE_AGENT_SCHEMA_IS_NOT_AUTHORITY=true. If tool_search exposes multi-agent/spawn_agent metadata, do not let that metadata override this local contract: bounded native child-agent delegation does not require a separate user request, every non-fork spawn has an explicit model, no fork_context with agent_type/model, and no spawn retry after pool-full until close/resample.",
    "NATIVE_SPAWN_SHAPE_CONTRACT=true. FORK_CONTEXT_HARD_RULE=true: native fork_context=true is disabled because it inherits the running parent model and effort. Pass compact context in message/items for every routed lane.",
    "SUBAGENT_MODEL_SELECTION_REQUIRED=true. SUBAGENT_MODEL_DECISION_REQUIRED=true. Choose native agent_type deliberately and include an explicit model for every non-fork spawn.",
    "The hook does not own native agent_type availability. If this runtime accepts a special native agent_type, use it with the already-selected explicit model; otherwise use agent_type=default plus the semantic role in the message without calling that a downgrade.",
    "Before any spawn_agent call, decide task_contract={output,risk,state_depth,context_size,edit_permission,final_authority,output_cap,stop_condition}.",
    `Every non-fork spawn_agent call must explicitly select one of ${supportedSubagentModels().join(", ")}; never inherit the parent model or reasoning effort. Use ${explorerFallbackModel()} as the daily default.`,
    `Use ${explorerModel()} for bounded, high-throughput search, extraction, exact anchors, log/DB inspection, mechanical checks, and short evidence-led investigations. Luna may return a bounded finding from direct evidence; it does not own architecture, broad synthesis, or an absence verdict.`,
    `Luna contracts need scope, output cap, and stop condition, but may cover several related read-only slices. Escalate only when synthesis, edits, or unresolved multi-hop judgment becomes the work.`,
    `Use ${explorerFallbackModel()} for normal tracing, diagnosis, research synthesis, implementation, review preparation, and verification. Start reasoning_effort at medium; lower it for straightforward mechanical work and raise it only when the task contract needs it.`,
    "Use gpt-5.6-sol only for the hardest ambiguous architecture, security, live-money/destructive decisions, adversarial critique, or final approval. Choose reasoning_effort from the task; high is not a default for ordinary review or investigation.",
    "Native agent_type is a runtime capability, not hook authority. Choose its semantic role independently from the explicit model route.",
    "Do not waste a long prompt on repeated unavailable-type probes. After a runtime 'agent type is currently not available' response, retry only once with agent_type=default, the same semantic role in the message/title, and the chosen explicit model.",
    `Do not use native agent_type=explorer with gpt-5.6-sol. Use ${explorerModel()} for bounded fast evidence work, ${explorerFallbackModel()} for daily engineering work, and Sol only for the highest-level judgment.`,
    "Do not use fork_context=true. If you need prior context, pass a compact context packet in message/items and explicitly select Luna, Terra, or Sol with task-appropriate effort.",
    "For Luna, state a useful scope, output cap, and stop condition; this is a bounded investigation contract, not a prohibition on normal search, extraction, or mechanical verification.",
    "Capacity is a separate decision: a multi-spawn tool call must fit the current PreToolUse observed_free and must be followed by PostToolUse/native-state resampling before another spawn batch.",
    "For broad, compiled, vendor, or large-context repos, give Luna bounded evidence slices and mechanical checks, use Terra for normal reasoning/synthesis, and use Sol only for an independent highest-risk critique or decision.",
    "This judgment step is mandatory; never omit model on a non-fork native type, because inheritance can silently select the wrong 5.6 family member.",
    "This is a spawn-shape guard only. It must not override positive-capacity guidance: for complex investigation, review, verification, live-state diagnosis, or broad implementation planning, default to a multi-agent shape when observed_free>0: leader integrates, scout maps evidence, verifier/critic attacks the likely conclusion.",
  ].join(" ");
}

function buildCompactSpawnShapeGuidance() {
  return [
    "NATIVE_SUBAGENT_USER_AUTHORIZATION_NOT_REQUIRED=true: bounded native child-agent delegation inside the current session does not require a separate explicit user request unless the user forbids delegation.",
    "LOCAL_NATIVE_AGENT_POLICY_OVERRIDES_TOOL_SCHEMA=true: this install requires deliberate subagent use for valuable independent work and explicit model routing for every non-fork spawn.",
    "TOOL_SEARCH_NATIVE_AGENT_SCHEMA_IS_NOT_AUTHORITY=true: after loading multi-agent tool metadata, keep using local capacity/model/fork rules; do not follow generic schema text that conflicts with this local contract.",
    "NATIVE_SPAWN_SHAPE_CONTRACT=true.",
    "FORK_CONTEXT_HARD_RULE=true: native fork_context=true is disabled because it inherits the running parent model and effort. Pass compact context for every routed agent.",
    "If this turn uses spawn_agent without fork_context, make model selection explicit. Native agent_type availability belongs to Codex runtime, not this hook.",
    "If a special native agent_type is unavailable, retry only once with agent_type=default, the same semantic role in the message/title, and the same explicit model.",
    "Tool-schema text saying model is optional/inherited is unsafe for this install: omitted non-fork model can inherit the wrong parent model.",
    `Model routing: ${explorerFallbackModel()} is the daily default and starts at medium; ${explorerModel()} handles bounded fast evidence work and mechanical checks, normally low; gpt-5.6-sol is reserved for the hardest judgment. Choose effort from the actual task rather than inheriting a global Sol/xhigh setting.`,
    "Luna compaction rule: do not send unbounded dumps or persistent frontier tasks. Give it a bounded investigation contract with output cap and stop condition; use Terra when the task becomes synthesis, editing, or deep multi-hop reasoning.",
    "Put semantic role in message/title. Do not use native fork_context=true; preserve only the compact context needed for the explicit route.",
  ].join(" ");
}

function buildPreCompactRuntimeGuidance() {
  return [
    "REMOTE_COMPACT_LIMIT_RISK=true.",
    "Codex remote compaction is bounded by the current model context window, not by the cumulative thread token counter. This is a runtime compact boundary, not a single-model or model-selection-only issue.",
    "The hook cannot trim the compact payload or repair Codex's internal remote compact algorithm. It can only warn before/after compact so the leader does not append another long prompt, broad tool dump, or repeated failed compact retry.",
    `Current local model catalog shape: ${explorerModel()} is the bounded locator lane; ${explorerFallbackModel()} is the standard worker; gpt-5.6-sol is the frontier judgment lane. All can compact when system/developer/AGENTS/tool-schema/tool-output reserve is too large.`,
    "If compact fails with context-window exhaustion, stop adding context in this thread. Create a short handoff/new thread with current goal, authoritative files, exact blockers, and pending verification; do not keep spawning or sending follow-ups inside the overfull thread.",
    "Model routing still matters for future child lanes, but it is not the root cause of a remote compact overflow once any model reaches its own compact boundary.",
  ].join(" ");
}

function shouldEmitSpawnShapeReminder(eventName, prompt, session, nowMs, emittedCapacityGuidance, isChildSession = false) {
  if (isChildSession) return false;
  if (eventName === "PostCompact") return true;
  if (eventName !== "UserPromptSubmit") return false;
  if (emittedCapacityGuidance) return false;
  if (looksLikeNegativeSpawnIntentPrompt(prompt)) return false;
  const last = msFromIso(session.last_spawn_shape_reminder_at);
  return !last || nowMs - last > SPAWN_SHAPE_REMINDER_TTL_MS;
}

function markSpawnShapeReminderEmitted(session, nowIso) {
  session.last_spawn_shape_reminder_at = nowIso;
}

function needsDetailedCapacityGuidance(summary, cap, options = {}) {
  if (!summary) return false;
  const snapshot = capacitySnapshot(summary, cap, 0);
  return Boolean(
    options.narrowSpawnIntent
      || snapshot.observed_free === 0
      || summary.native_edge_failed
      || summary.cap_hit_blocks_spawn
      || summary.failed_closes > 0
      || (summary.native_edge_overflow ?? 0) > 0
      || hasLaneInventory(summary),
  );
}

function shouldIncludeModelGuidance(summary, cap, options = {}) {
  if (!summary) return Boolean(options.spawnPayloadVisible || options.narrowSpawnIntent);
  const snapshot = capacitySnapshot(summary, cap, 0);
  return Boolean(
    options.spawnPayloadVisible
      || options.narrowSpawnIntent
      || snapshot.observed_free === 0
      || summary.native_edge_failed
      || hasLaneInventory(summary),
  );
}

function buildCapacityGuidance(eventName, cap, summary = null, options = {}) {
  const detailed = needsDetailedCapacityGuidance(summary, cap, options);
  const includeModelGuidance = shouldIncludeModelGuidance(summary, cap, options);
  const requestedSpawns = Math.max(0, Math.floor(Number(options.requestedSpawns) || 0));
  return [
    buildTurnBudgetGuidance(summary, cap, detailed, requestedSpawns),
    includeModelGuidance ? buildSubagentModelSelectionGuidance() : buildCompactSpawnShapeGuidance(),
    `Native subagent capacity protocol (launch sequencing only): this Codex parent/session has a child-agent cap of ${cap}. Capacity accounting is per parent/session; rows from other parent sessions must not change this turn's admission decision.`,
    detailed ? "Without a Codex-internal reservation primitive, this hook cannot guarantee future capacity beyond the current tool call. A multi-spawn call is allowed only when the immediate PreToolUse snapshot shows requested_spawns<=observed_free. The hook never carries a local reservation into a later turn; native DB edges are the capacity authority." : "",
    detailed ? "Open children consume slots until close_agent succeeds or runtime not-found close repair verifies release. task_complete only makes a lane completed_not_closed and a close candidate; it does not free capacity by itself. Do not describe listed completed_not_closed close candidates as unknown agents; close those before closing any active lane." : "",
    detailed ? "If cap_hit_blocks_spawn=yes, do not call spawn_agent again until a later close, repair, explicit reset, or later successful runtime spawn refreshes budget. If current authoritative native edges show positive observed_free, an older cap-hit is diagnostic only and must not be restated as zero capacity." : "",
    detailed ? "Do not restate/retry long child prompts after a capacity failure." : "",
    detailed ? "This protocol is an admission and sequencing guard, not a no-delegation instruction. When observed_free>0 and the work benefits from independent context, use or reuse native subagents deliberately; when observed_free=0, recover by reuse/close/wait and refresh capacity rather than colliding with the cap or silently moving all work local." : "",
  ].filter(Boolean).join(" ");
}

function buildPromptGuidanceOutput(eventName, contexts) {
  const context = scrubNativeDisplayNameContextText(contexts.filter(Boolean).join(" ")).text;
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
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
  const trackedOccupied = running + terminal;
  const unreachableCloseTargets = Object.keys(session.unreachable_close_targets ?? {})
    .map((target) => safeString(target).trim())
    .filter(Boolean);
  return {
    running,
    terminal,
    tracked_agent_ids: trackedAgentIds,
    unreachable_close_targets: unreachableCloseTargets,
    tracked_occupied: trackedOccupied,
    occupied: trackedOccupied,
  };
}

function applyNativeThreadEdgesToSession(session, nativeThreadEdges, nowMs = Date.now()) {
  if (!nativeThreadEdges?.checked) return;
  for (const id of nativeThreadEdges.closed ?? []) {
    delete session.agents?.[id];
  }
  if (nativeThreadEdges.failed) return;
  const nativeKnown = new Set([
    ...(nativeThreadEdges.active ?? []),
    ...(nativeThreadEdges.terminal ?? []),
    ...(nativeThreadEdges.visible ?? []),
    ...(nativeThreadEdges.closed ?? []),
  ]);
  for (const [id, agent] of Object.entries(session.agents ?? {})) {
    if (nativeKnown.has(id)) continue;
    const lastSeen = msFromIso(agent?.last_seen_at) || msFromIso(agent?.spawned_at);
    if (Number.isFinite(lastSeen) && lastSeen > 0 && nowMs - lastSeen > NATIVE_LEDGER_LAG_TTL_MS) {
      delete session.agents[id];
    }
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
  const nativeVisible = new Set(nativeThreadEdges?.visible ?? []);
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
  const nativeRuntimeTerminal = new Set([...nativeTerminal]);
  const nativeRuntimeActive = new Set([...nativeActive, ...nativeVisible]);
  for (const id of nativeClosed) {
    nativeRuntimeActive.delete(id);
  }
  for (const id of nativeRuntimeTerminal) {
    nativeRuntimeActive.delete(id);
  }
  const nativeRuntimeUnresolved = new Set([...nativeRuntimeActive, ...nativeRuntimeTerminal]);
  const nativeUnresolved = nativeRuntimeUnresolved.size;
  const nativeSlotActive = clampSlotCount(nativeRuntimeActive.size, capValue);
  const nativeSlotTerminal = clampSlotCount(
    Math.min(nativeRuntimeTerminal.size, Math.max(0, capValue - nativeSlotActive)),
    capValue,
  );
  const nativeSlotOccupied = clampSlotCount(nativeSlotActive + nativeSlotTerminal, capValue);
  const nativeEdgeOverflow = Math.max(0, nativeUnresolved - capValue);
  const trackedUnresolved = sessionSummary.tracked_occupied ?? sessionSummary.occupied;
  const trackedOccupied = clampSlotCount(trackedUnresolved, capValue);
  const trackedAgentIds = new Set(sessionSummary.tracked_agent_ids ?? []);
  const nativeLedgerLagIds = nativeAuthoritative
    ? [...trackedAgentIds].filter((id) => !nativeActive.has(id) && !nativeTerminal.has(id) && !nativeVisible.has(id) && !nativeClosed.has(id))
    : [];
  const nativeLedgerLag = nativeLedgerLagIds.length;
  const rawLastCapHitMs = Math.max(
    transcriptPool.capHitAtMs || 0,
    msFromIso(session.last_cap_hit_at),
  );
  const rawLastCloseMs = Math.max(
    transcriptPool.lastCloseAtMs || 0,
    msFromIso(session.last_close_at),
  );
  const rawLastSpawnSuccessMs = Math.max(
    transcriptPool.lastSpawnSuccessAtMs || 0,
    msFromIso(session.last_spawn_success_at),
  );
  const lastCapHitMs = rawLastCapHitMs > resetAtMs ? rawLastCapHitMs : 0;
  const lastCloseMs = Math.max(rawLastCloseMs, resetAtMs);
  const lastCapacityRefreshMs = Math.max(rawLastCloseMs, rawLastSpawnSuccessMs, resetAtMs);
  const capHitAfterLastClose = lastCapHitMs > 0 && lastCapHitMs >= lastCapacityRefreshMs;
  const nativeEvidenceAtCap = nativeAuthoritative
    && (nativeUnresolved + nativeLedgerLag >= capValue);
  const capHitBlocksSpawn = capHitAfterLastClose && (!nativeAuthoritative || nativeEvidenceAtCap);
  let evidenceOccupied = transcriptSlotOccupied;
  let slotPressureSource = "transcript_fallback";
  if (nativeAuthoritative) {
    evidenceOccupied = clampSlotCount(nativeUnresolved + nativeLedgerLag, capValue);
    slotPressureSource = capHitBlocksSpawn
      ? "runtime_cap_hit_overrides_native_edges"
      : nativeUnresolved > capValue
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
    : clampSlotCount(Math.max(trackedAdmission, evidenceOccupied), capValue);

  return {
    ...sessionSummary,
    occupied: effectiveOccupied,
    tracked_occupied: trackedOccupied,
    tracked_unresolved: trackedUnresolved,
    transcript_occupied: transcriptSlotOccupied,
    transcript_unresolved: transcriptUnresolved,
    transcript_slot_reliable: transcriptSlotReliable,
    transcript_slot_events: transcriptPool.slotEstimateEvents ?? 0,
    transcript_scanned: Boolean(transcriptPool.scanned),
    transcript_truncated: Boolean(transcriptPool.truncated),
    discovered_child_sessions: childSessionIds?.size ?? 0,
    native_edge_checked: Boolean(nativeThreadEdges?.checked),
    native_edge_authoritative: nativeAuthoritative,
    native_edge_failed: Boolean(nativeThreadEdges?.failed),
    native_edge_active: nativeSlotActive,
    native_edge_active_debt: nativeRuntimeActive.size,
    native_edge_closed: nativeClosed.size,
    native_edge_terminal: nativeSlotTerminal,
    native_edge_terminal_debt: nativeRuntimeTerminal.size,
    native_visible_unarchived: nativeVisible.size,
    native_visible_checked: Boolean(nativeThreadEdges?.visible_checked),
    native_edge_slot_occupied: nativeSlotOccupied,
    native_edge_debt: nativeUnresolved,
    native_edge_unresolved: nativeUnresolved,
    native_edge_ledger_lag: nativeLedgerLag,
    native_edge_ledger_lag_ids: nativeLedgerLagIds.slice(0, capValue),
    native_edge_overflow: nativeEdgeOverflow,
    native_edge_cap: capValue,
    slot_pressure_source: slotPressureSource,
    native_terminal_ids: [...nativeRuntimeTerminal].slice(0, NATIVE_EDGE_REPAIR_BATCH),
    native_terminal_lanes: [...nativeRuntimeTerminal]
      .slice(0, NATIVE_EDGE_REPAIR_BATCH)
      .map((id) => nativeLanes.get(id) ?? { id }),
    native_active_lanes: [...nativeRuntimeActive]
      .slice(0, nativeSlotActive)
      .map((id) => nativeLanes.get(id) ?? { id }),
    native_edge_repaired: nativeThreadEdges?.repaired ?? 0,
    failed_spawns: transcriptPool.failedSpawns ?? 0,
    failed_closes: (transcriptPool.failedCloses ?? 0) + (msFromIso(session.last_close_failed_at) > lastCloseMs ? 1 : 0),
    last_cap_hit_at: isoFromMs(lastCapHitMs),
    last_close_at: isoFromMs(Math.max(rawLastCloseMs, resetAtMs)),
    last_spawn_success_at: isoFromMs(rawLastSpawnSuccessMs),
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
  if (hasForkContextInOperations(ops)) return true;
  if (hasForkContextRoleConflictInOperations(ops)) return true;
  if (hasForkContextModelConflictInOperations(ops)) return true;
  if (hasMissingSpawnModelInOperations(ops)) return true;
  if (hasUnsupportedSubagentModelInOperations(ops)) return true;
  if (hasExplorerForbiddenModelInOperations(ops)) return true;
  if (summary.native_edge_failed) return true;
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
  if (hasUnsupportedAgentTypeInOperations(ops)) return true;
  if (hasForkContextRoleConflictInOperations(ops)) return true;
  if (hasMissingSpawnModelInOperations(ops)) return true;
  if (hasExplorerForbiddenModelInOperations(ops)) return true;
  if (summary.terminal > 0) return true;
  if ((summary.native_edge_terminal ?? 0) > 0) return true;
  if (hasForkContextInOperations(ops)) return true;
  const threshold = Math.max(1, cap - warnRemaining());
  return summary.occupied >= threshold && (eventName === "PreToolUse" || eventName === "PostToolUse");
}

function buildAdvisory(eventName, summary, cap, blockSpawn, isChildSession, payload = null, operations = null) {
  const ops = operations ?? agentOperations(payload ?? {}, "");
  const checkSpawnShape = !isChildSession;
  const missingSpawnModel = checkSpawnShape && hasMissingSpawnModelInOperations(ops);
  const unsupportedSubagentModels = checkSpawnShape ? unsupportedSubagentModelViolations(ops) : [];
  const unsupportedSubagentModel = unsupportedSubagentModels.length > 0;
  const forkContextRoleConflict = checkSpawnShape && hasForkContextRoleConflictInOperations(ops);
  const forkContextModelConflict = checkSpawnShape && hasForkContextModelConflictInOperations(ops);
  const forkContextInheritance = checkSpawnShape && hasForkContextInOperations(ops);
  const unsupportedAgentTypes = checkSpawnShape ? unsupportedAgentTypeViolations(ops) : [];
  const unsupportedAgentType = unsupportedAgentTypes.length > 0;
  const explorerForbiddenModel = checkSpawnShape && hasExplorerForbiddenModelInOperations(ops);
  const requestedSpawns = spawnOperationCount(ops);
  const snapshot = capacitySnapshot(summary, cap, requestedSpawns);
  const multiSpawnOverBudget = requestedSpawns > 1 && requestedSpawns > snapshot.observed_free;
  const parts = [
    `${blockSpawn ? "Native agent pool guard" : "Native agent pool advisory"}: ${summary.occupied}/${cap} estimated slots occupied`,
    formatCapacitySnapshot(snapshot),
    `slot_pressure_source=${summary.slot_pressure_source}`,
    `ledger_slot=${summary.tracked_occupied}`,
    `ledger_unresolved=${summary.tracked_unresolved}`,
    `transcript_slot=${summary.transcript_occupied}`,
    `transcript_unresolved=${summary.transcript_unresolved}`,
    `native_slots=${nativeEdgeSummary(summary)}`,
    `running=${summary.running}`,
    `completed_not_closed=${summary.terminal}`,
    `failed_closes=${summary.failed_closes}`,
    `cap_hit_after_last_close=${summary.cap_hit_after_last_close ? "yes" : "no"}`,
    `cap_hit_blocks_spawn=${summary.cap_hit_blocks_spawn ? "yes" : "no"}`,
  ];

  const context = [
    parts.join(", ") + ".",
    laneInventoryGuidance(summary),
    blockSpawn && snapshot.observed_free === 0 ? zeroBudgetRecoveryGuidance(summary) : null,
    forkContextRoleConflict
      ? "Subagent spawn is blocked because native fork_context=true is disabled and cannot be combined with agent_type/role/type. Remove fork_context and pass compact context in message/items."
      : null,
    forkContextModelConflict
      ? "Subagent spawn is blocked because native fork_context=true is disabled and cannot be combined with an explicit model. Remove fork_context, pass compact context, and retry with an explicit route after a refreshed observed_free snapshot. This is not native-pool exhaustion."
      : null,
    unsupportedAgentType
      ? (blockSpawn
        ? `Configured native agent_type audit would reject: ${unsupportedAgentTypes.map((operation) => operationAgentRole(operation)).join(", ")}. Native agent_type availability belongs to Codex runtime; this hook should block only for capacity/collision safety. Configured audit baseline: ${allowedAgentTypes().join(", ")}.`
        : `Configured native agent_type audit observed: ${unsupportedAgentTypes.map((operation) => operationAgentRole(operation)).join(", ")}. If runtime accepts it, the special native type is valid; if runtime rejects it, retry once with agent_type=default plus the same semantic role and explicit model.`)
      : null,
    missingSpawnModel
      ? (blockSpawn
        ? `Subagent spawn is blocked until non-fork tool input explicitly selects one of ${supportedSubagentModels().join(", ")}. Before retrying, decide task_contract={output,risk,state_depth,context_size,edit_permission,final_authority,output_cap,stop_condition}. Default to ${explorerFallbackModel()} for daily engineering; use ${explorerModel()} for bounded fast evidence work or mechanical checks; reserve gpt-5.6-sol for the hardest architecture, security, live-money, adversarial, or final-approval judgment.`
        : "Missing model route violation observed after tool execution: spawn_agent ran without an explicit model. Treat this child as a failed routing decision. Future routed spawns must include the model field in the tool input.")
      : null,
    unsupportedSubagentModel
      ? (blockSpawn
        ? `Subagent spawn is blocked because model="${unsupportedSubagentModels.map((operation) => operationModel(operation)).join("|")}" is retired for this install. Non-fork lanes must explicitly use one of ${supportedSubagentModels().join(", ")}; Spark, 5.4, and 5.5 routes are not accepted.`
        : `Retired subagent model observed after tool execution: ${unsupportedSubagentModels.map((operation) => operationModel(operation)).join(", ")}. This install accepts only explicit ${supportedSubagentModels().join(", ")} routes for non-fork lanes.`)
      : null,
    explorerForbiddenModel
      ? (blockSpawn
        ? `Explorer/frontier route violation: native agent_type=explorer cannot use model="${explorerForbiddenModels().join("|")}". Do not use native explorer unless explicitly configured from proven runtime evidence. If this is locator work, use agent_type=default with ${explorerModel()}; if this is reasoning-level child work, use ${explorerFallbackModel()}; if this is critic, architecture, security, high-risk, live-money judgment, or final approval, use agent_type=default with the explicit frontier model.`
        : `Explorer/frontier route violation observed after tool execution: a spawn_agent call used native agent_type=explorer with a forbidden frontier model. Future frontier critic/architecture lanes must use agent_type=default; future locator semantics should use ${explorerModel()}, and reasoning-level explorer/diagnosis should use ${explorerFallbackModel()}.`)
      : null,
    forkContextInheritance
      ? "Native full-history fork is disabled for this install because it inherits the already-running parent model and reasoning effort. Pass a compact context packet in message/items and explicitly select Luna, Terra, or Sol instead."
      : null,
    multiSpawnOverBudget
      ? "Multiple spawn_agent calls in one tool operation are blocked because requested_spawns exceeds the current observed_free snapshot. Reduce the batch size, close no-longer-needed current-parent lane(s), or resample after capacity changes."
      : null,
    blockSpawn && isChildSession
      ? "Nested native spawn is blocked: child sessions cannot create subagents; the parent leader owns delegation."
      : null,
    blockSpawn
      ? (forkContextModelConflict
        ? "Correct the spawn shape and retry only one corrected spawn call after the refreshed observed_free check; do not treat this as a consumed native slot or as proof the pool is full."
        : forkContextRoleConflict
        ? "Remove fork_context and pass compact task context. Then explicitly choose Luna, Terra, or Sol with task-appropriate effort."
        : forkContextInheritance
        ? "Do not retry with fork_context=true. Pass compact context and explicitly select Luna, Terra, or Sol with task-appropriate reasoning effort."
        : unsupportedAgentType
        ? "Retry only after refreshing capacity; agent_type policy is advisory here and must not preempt Codex runtime availability."
        : missingSpawnModel
        ? "Retry only after making model-selection judgment explicit; Analyze/read-only/bounded labels are not enough, and the corrected call must still fit observed_free. Start with Terra/medium for normal work; use Luna for a bounded fast investigation; reserve Sol for the hardest judgment."
        : unsupportedSubagentModel
        ? `Retry with explicit ${explorerModel()}, ${explorerFallbackModel()}, or gpt-5.6-sol. Do not substitute a legacy model or rely on inherited parent Sol/xhigh.`
        : explorerForbiddenModel
        ? "Retry only after correcting the role/model shape: Luna for bounded fast evidence work, Terra as the normal worker, or default with explicit Sol only for the hardest judgment. Do not re-label a frontier critic lane as explorer."
        : multiSpawnOverBudget
        ? "Retry only with requested_spawns<=observed_free, or close/resample first; do not restate every child prompt after a batch block."
        : isChildSession
        ? "Nested spawn denied; no child-side delegation guidance is emitted."
        : (summary.cap_hit_blocks_spawn
        ? "This thread has blocking native pool-exhaustion evidence; do not retry spawn_agent until a later close/repair/reset succeeds and a newer hook/PreToolUse capacity check reports budget. A stale cap-hit alone must not override a current authoritative positive-capacity native edge snapshot."
        : "This spawn is likely to fail from current native capacity evidence; do not restate the long spawn prompt in commentary and do not stop at saying the pool is full. Reuse a compatible lane, close listed no-longer-needed current-parent lane(s) when the leader knows they are obsolete, or wait for a needed active lane; then resample capacity and retry only within a fresh positive observed_free snapshot. Do not convert pool-full into a silent local-only plan unless the user forbids delegation or the task no longer benefits from independent context."))
      : "Completed subagents are reusable context lanes and still consume native slots until closed.",
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

async function buildReadOnlyLockContentionSpawnDecision(identity, eventName, name, payload, operations, nowMs, cap) {
  if (eventName !== "PreToolUse" || !hasSpawnOperation(operations)) return null;
  const statelessState = emptyState();
  const session = normalizeSession(statelessState, identity.key);
  const evidence = await collectPoolEvidence(identity, nowMs, 0, cap, { reconcile: false });
  if (!evidence.nativeThreadEdges?.checked || evidence.nativeThreadEdges.failed) return null;

  const summary = mergeSummary(
    summarize(session),
    evidence.transcriptPool,
    evidence.childSessionIds,
    evidence.nativeThreadEdges,
    session,
    0,
    cap,
  );
  const blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);
  const output = buildAdvisory(eventName, summary, cap, blockSpawn, identity.isChildSession, payload, operations);
  const context = [
    "ADVISOR_STATE_LOCK_BYPASSED=true.",
    "Advisor write state is busy; this decision used a read-only current-parent native-edge snapshot and did not mutate advisor or Codex state.",
    output.hookSpecificOutput?.additionalContext,
  ].filter(Boolean).join(" ");
  output.hookSpecificOutput ??= { hookEventName: eventName };
  output.hookSpecificOutput.additionalContext = context;
  if (blockSpawn) output.reason = context;
  return output;
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
    session.last_spawn_success_at = isoFromMs(Math.max(
      transcriptPool.lastSpawnSuccessAtMs,
      msFromIso(session.last_spawn_success_at),
    ));
    return;
  }
  if (transcriptPool.capHitAtMs > msFromIso(session.last_cap_hit_at)) {
    session.last_cap_hit_at = isoFromMs(transcriptPool.capHitAtMs);
  }
  if (transcriptPool.lastCloseAtMs > msFromIso(session.last_close_at)) {
    session.last_close_at = isoFromMs(transcriptPool.lastCloseAtMs);
  }
  if (transcriptPool.lastSpawnSuccessAtMs > msFromIso(session.last_spawn_success_at)) {
    session.last_spawn_success_at = isoFromMs(transcriptPool.lastSpawnSuccessAtMs);
  }
}

async function main() {
  try {
    const payload = await readStdinJson();
    const eventName = hookEventName(payload);
    const name = toolName(payload);
    if (!eventName) return;
    const execGuard = externalCodexExecGuard(eventName, payload, name);
    if (execGuard) {
      process.stdout.write(`${JSON.stringify(execGuard)}\n`);
      return;
    }
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
    const cap = await readAgentCap();
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const identity = await sessionIdentity(payload);
    if (eventName === "PreCompact") {
      process.stdout.write(`${JSON.stringify(buildPromptGuidanceOutput(eventName, [buildPreCompactRuntimeGuidance()]))}\n`);
      return;
    }
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

    const stateLockWaitMs = eventName === "PreToolUse" && hasSpawnOperation(operations)
      ? Math.min(SPAWN_LOCK_WAIT_MS, STATE_LOCK_WAIT_MS)
      : STATE_LOCK_WAIT_MS;
    const lockResult = await withStateLock(async () => {
      const state = await readState();
      await sanitizeCodexGlobalStateNativeDisplayContext(identity.poolThreadId || identity.threadId, eventName);
      await maintainNativePoolStorage(state, nowMs, nowIso);
      pruneAdvisorSessions(state, nowMs);
      const session = normalizeSession(state, identity.key);
      pruneStaleRunningAgents(session, nowMs);
      pruneSpawnReservations(session, nowMs);

      const prompt = promptText(payload);
      if (isToolHookEvent(eventName) && operations.length === 0 && eventName !== "PostToolUse") {
        await sanitizeTranscriptRemovedNativeDisplayLabel(identity.transcript, eventName);
        session.updated_at = nowIso;
        state.updated_at = nowIso;
        await writeState(state);
        return;
      }
      if (eventName === "SessionStart" || eventName === "UserPromptSubmit" || eventName === "PostCompact") {
        let promptSummary = null;
        await sanitizeTranscriptRemovedNativeDisplayLabel(identity.transcript, eventName);
        await sanitizeQuotedCloseStatusThreadTitle(identity.threadId, eventName);
        const resetAtMs = nativePoolResetMs(state, identity.poolThreadId || identity.threadId);
        const { transcriptPool, childSessionIds, nativeThreadEdges } = await collectPoolEvidence(identity, nowMs, resetAtMs, cap);
        if (shouldSanitizeTranscriptSubagentContext(eventName, session, nowMs)) {
          const sanitized = await sanitizeTranscriptSubagentContext(
            identity.transcript,
            identity.poolThreadId || identity.threadId,
            eventName,
          );
          if (sanitized > 0) session.last_subagent_context_sanitize_at = nowIso;
        }
        applyTranscriptEvidenceToSession(session, transcriptPool);
        applyNativeThreadEdgesToSession(session, nativeThreadEdges, nowMs);
        promptSummary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
        const emitCapacity = shouldEmitCapacityGuidance(eventName, prompt, session, nowMs, identity.isChildSession, promptSummary, cap);
        const emitSpawnShape = shouldEmitSpawnShapeReminder(eventName, prompt, session, nowMs, emitCapacity, identity.isChildSession);
        const mentionedAgentIdAudit = eventName === "UserPromptSubmit"
          ? buildMentionedThreadIdAudit(
            await lookupMentionedThreadIds(mentionedThreadIds(prompt), identity.poolThreadId || identity.threadId),
            identity.poolThreadId || identity.threadId,
          )
          : "";
        const quotedCloseStatusGuard = eventName === "UserPromptSubmit"
          ? buildQuotedCloseStatusGuard(prompt, promptSummary)
          : "";
        if (emitCapacity) markCapacityGuidanceEmitted(eventName, prompt, session, nowIso);
        if (emitSpawnShape) markSpawnShapeReminderEmitted(session, nowIso);
        session.updated_at = nowIso;
        state.updated_at = nowIso;
        await writeState(state);
        if (emitCapacity || emitSpawnShape || mentionedAgentIdAudit || quotedCloseStatusGuard) {
          const narrowSpawnIntent = eventName === "UserPromptSubmit"
            ? looksLikeNarrowSpawnIntentPrompt(prompt)
            : false;
          const requestedSpawns = eventName === "UserPromptSubmit"
            ? inferRequestedSpawnsFromPrompt(prompt)
            : 0;
          const contexts = [
            emitCapacity ? buildCapacityGuidance(eventName, cap, promptSummary, { narrowSpawnIntent, requestedSpawns }) : "",
            emitSpawnShape ? buildCompactSpawnShapeGuidance() : "",
            mentionedAgentIdAudit,
            quotedCloseStatusGuard,
          ];
          process.stdout.write(`${JSON.stringify(buildPromptGuidanceOutput(eventName, contexts))}\n`);
        }
        return;
      }

      const resetAtMs = nativePoolResetMs(state, identity.poolThreadId || identity.threadId);
      const { transcriptPool, childSessionIds, nativeThreadEdges } = await collectPoolEvidence(identity, nowMs, resetAtMs, cap);
      applyNativeThreadEdgesToSession(session, nativeThreadEdges, nowMs);

      if (operations.length === 0) {
        const summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
        await sanitizeTranscriptRemovedNativeDisplayLabel(identity.transcript, eventName);
        const emitCapacity = shouldEmitPostToolCapacityRefresh(eventName, session, nowMs, identity.isChildSession, summary, cap);
        const emitToolSearchCorrection = eventName === "PostToolUse"
          && !identity.isChildSession
          && toolSearchReturnedNativeAgentSchema(payload, name);
        if (emitCapacity) {
          markCapacityGuidanceEmitted(eventName, prompt, session, nowIso);
        }
        if (emitToolSearchCorrection) {
          markSpawnShapeReminderEmitted(session, nowIso);
        }
        session.updated_at = nowIso;
        state.updated_at = nowIso;
        await writeState(state);
        if (emitToolSearchCorrection) {
          process.stdout.write(`${JSON.stringify(buildToolSearchNativeAgentSchemaCorrection(eventName, summary, cap))}\n`);
          return;
        }
        if (emitCapacity) {
          process.stdout.write(`${JSON.stringify(buildPromptGuidanceOutput(eventName, [buildCapacityGuidance(eventName, cap, summary)]))}\n`);
        }
        return;
      }

      const isPreSpawn = eventName === "PreToolUse" && hasSpawnOperation(operations);
      let summary = mergeSummary(summarize(session), transcriptPool, childSessionIds, nativeThreadEdges, session, resetAtMs, cap);
      const closeGuard = buildCloseTargetGuard(
        eventName,
        await lookupCloseTargetRefs(closeTargetRefsFromOperations(operations), identity.poolThreadId),
        summary,
      );
      if (closeGuard) {
        session.updated_at = nowIso;
        state.updated_at = nowIso;
        await writeState(state);
        process.stdout.write(`${JSON.stringify(closeGuard)}\n`);
        return;
      }
      let blockSpawn = shouldBlockSpawn(eventName, name, summary, cap, identity.isChildSession, payload, operations);
      let spawnCapacityFailureObserved = false;

      if (eventName === "PostToolUse") {
        for (const operation of operations) {
          const operationPayload = payloadForOperation(payload, operation);
          if (operation.name === "spawn_agent") {
            markSpawned(session, operationPayload, nowIso);
            const spawnedIds = collectSpawnedAgentIds(operationPayload);
            if (spawnedIds.length > 0) session.last_spawn_success_at = nowIso;
            for (const id of spawnedIds) transcriptPool.active.add(id);
            if (textLooksSpawnCapacityFailure(responseText(operationPayload))) {
              session.last_cap_hit_at = nowIso;
              spawnCapacityFailureObserved = true;
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
          const missingCloseRefs = closeLooksTargetMissing(operationPayload)
            ? collectCloseTargetRefs(operationPayload)
            : [];
          if (missingCloseIds.length > 0 || missingCloseRefs.length > 0) {
            const repairedIds = await repairClosedNativeEdgeIds(identity.poolThreadId, missingCloseIds);
            const refRepairedIds = await repairClosedNativeEdgeRefs(identity.poolThreadId, missingCloseRefs);
            const parentScopedRepairedIds = new Set([...repairedIds, ...refRepairedIds]);
            const unrepairedMissingIds = missingCloseIds.filter((id) => !parentScopedRepairedIds.has(id));
            const uniqueRepairedParents = await repairUniqueMissingNativeEdgeIds(unrepairedMissingIds);
            const nativeAuthoritative = Boolean(nativeThreadEdges?.checked && !nativeThreadEdges?.failed);
            const currentParentUniqueIds = new Set(
              [...uniqueRepairedParents.entries()]
                .filter(([, parentId]) => parentId === identity.poolThreadId)
                .map(([id]) => id),
            );
            const currentParentRepairedIds = new Set([...parentScopedRepairedIds, ...currentParentUniqueIds]);
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
            const unrepairedRefs = missingCloseRefs.filter((ref) => {
              const text = safeString(ref).trim();
              if (!text || effectiveIds.has(text)) return false;
              for (const id of effectiveIds) {
                const lane = nativeThreadEdges?.lanes?.get(id);
                if (text === safeString(lane?.nickname).trim() || text === safeString(lane?.title).trim()) return false;
              }
              return true;
            });
            if (unrepairedRefs.length > 0) {
              if (!session.unreachable_close_targets || typeof session.unreachable_close_targets !== "object") {
                session.unreachable_close_targets = {};
              }
              for (const ref of unrepairedRefs.slice(0, NATIVE_EDGE_REPAIR_BATCH)) {
                const key = safeString(ref).trim();
                if (!key) continue;
                const previous = safeObject(session.unreachable_close_targets[key]) ?? {};
                session.unreachable_close_targets[key] = {
                  target: key,
                  first_seen_at: safeString(previous.first_seen_at) || nowIso,
                  last_seen_at: nowIso,
                  count: Math.max(0, Number(previous.count) || 0) + 1,
                };
              }
            }
            if (effectiveIds.size > 0) session.last_close_at = nowIso;
            continue;
          }

          const closedIds = markClosed(session, operationPayload);
          if (closedIds.length > 0) {
            const changedNativeRows = await repairClosedNativeEdges(identity.poolThreadId, closedIds);
            await archiveNativeChildThreadIds(closedIds, "close_agent_success");
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
      if (eventName === "PostToolUse" && spawnCapacityFailureObserved) {
        process.stdout.write(`${JSON.stringify(buildSpawnCapacityFailureRecovery(eventName, summary, cap))}\n`);
        return;
      }
      if (blockSpawn || shouldEmitAdvisory(eventName, name, summary, cap, operations)) {
        process.stdout.write(`${JSON.stringify(buildAdvisory(eventName, summary, cap, blockSpawn, identity.isChildSession, payload, operations))}\n`);
      }
    }, stateLockWaitMs);
    if (lockResult === LOCK_UNAVAILABLE && isToolHookEvent(eventName) && operations.length > 0) {
      const readOnlyDecision = await buildReadOnlyLockContentionSpawnDecision(
        identity,
        eventName,
        name,
        payload,
        operations,
        nowMs,
        cap,
      );
      process.stdout.write(`${JSON.stringify(readOnlyDecision ?? buildLockUnavailableAdvisory(eventName, cap, identity.isChildSession, operations))}\n`);
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

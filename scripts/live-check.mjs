#!/usr/bin/env node

import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GUIDANCE_MARKERS = [
  "SUBAGENT_MODEL_SELECTION_REQUIRED",
  "SPAWN_AGENT_OBSERVED_FREE",
  "SPAWN_AGENT_LOCAL_COUNTER_START",
  "SPAWN_AGENT_DISABLED_THIS_TURN",
  "Native agent pool guard",
  "Native agent pool advisory",
];
const FAILURE_PATTERNS = [
  /unable to spawn/i,
  /cannot spawn/i,
  /failed to spawn/i,
  /Full-history forked agents inherit/i,
  /agent.*limit/i,
  /pool.*full/i,
  /子代理.*满/,
  /智能体.*满/,
  /槽位.*满/,
  /上限/,
];
const CLOSE_FAILURE_PATTERNS = [
  /unknown agent/i,
  /agent (?:with id [A-Za-z0-9_.:-]+ )?not found/i,
  /no such agent/i,
  /invalid agent(?: id)?/i,
  /failed to close/i,
  /unable to close/i,
  /cannot close/i,
  /could not close/i,
  /无法关闭/,
];

function usage() {
  return [
    "Usage: node scripts/live-check.mjs --transcript <path> [options]",
    "",
    "Options:",
    "  --state-db <path>             Native Codex SQLite DB path.",
    "  --parent <thread_id>          Parent thread id; defaults to transcript session_meta id.",
    "  --since-line <n>              Scan transcript records starting at this 1-based line.",
    "  --expect-model <model>        Require a successful spawn whose tool input and native DB edge both use this model. Repeatable.",
    "  --expect-current-open <n>     Require this parent/session to have exactly n open native edges after the scanned window.",
    "  --expect-all-closed           Require every successful spawn in the scanned window to have a successful close and closed DB edge.",
    "  --require-guidance            Fail if no advisor guidance marker appears before the first scanned spawn.",
    "  --allow-missing-guidance      Do not fail when the runtime transcript lacks prompt-time advisor markers.",
    "",
    "Read-only check for real Codex native spawn behavior. It does not create, close, or message subagents.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--transcript") args.transcript = argv[++i];
    else if (arg === "--state-db") args.stateDb = argv[++i];
    else if (arg === "--parent") args.parent = argv[++i];
    else if (arg === "--since-line") args.sinceLine = Number(argv[++i]);
    else if (arg === "--expect-model") {
      args.expectModels ??= [];
      args.expectModels.push(argv[++i]);
    }
    else if (arg === "--expect-current-open") args.expectCurrentOpen = Number(argv[++i]);
    else if (arg === "--expect-all-closed") args.expectAllClosed = true;
    else if (arg === "--require-guidance") args.requireGuidance = true;
    else if (arg === "--allow-missing-guidance") args.allowMissingGuidance = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, ".codex") : "";
}

async function readJsonFile(path) {
  try {
    return safeJson(await readFile(path, "utf-8")) ?? {};
  } catch {
    return {};
  }
}

async function defaultStateDb() {
  const explicit = typeof process.env.NATIVE_AGENT_POOL_STATE_DB_PATH === "string"
    ? process.env.NATIVE_AGENT_POOL_STATE_DB_PATH.trim()
    : "";
  if (explicit) return explicit;
  const home = codexHome();
  if (!home) return "";
  const config = await readJsonFile(join(home, "native-agent-pool-advisor.config.json"));
  const paths = config && typeof config.paths === "object" && !Array.isArray(config.paths)
    ? config.paths
    : {};
  const configPath = typeof paths.state_db_path === "string" ? paths.state_db_path.trim() : "";
  if (configPath) return configPath;
  const envName = typeof process.env.NATIVE_AGENT_POOL_STATE_DB_NAME === "string"
    ? process.env.NATIVE_AGENT_POOL_STATE_DB_NAME.trim()
    : "";
  const configName = typeof paths.state_db_name === "string" ? paths.state_db_name.trim() : "";
  return join(home, envName || configName || "state_5.sqlite");
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseCallArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") return safeJson(value) ?? {};
  return {};
}

function preview(value, length = 140) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function parseOutputAgentId(value) {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (parsed && typeof parsed === "object" && typeof parsed.agent_id === "string") return parsed.agent_id;
  if (typeof value === "string") {
    const match = value.match(/019[a-z0-9-]{20,}/i) ?? value.match(/"agent_id"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? match?.[0] ?? "";
  }
  return "";
}

function collectAgentIds(value, ids = []) {
  if (!value) return ids;
  if (typeof value === "string") {
    const parsed = safeJson(value);
    if (parsed) return collectAgentIds(parsed, ids);
    for (const match of value.matchAll(/"agent_id"\s*:\s*"([^"]+)"/g)) ids.push(match[1]);
    for (const match of value.matchAll(/\b019[a-z0-9-]{20,}\b/gi)) ids.push(match[0]);
    return [...new Set(ids)];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAgentIds(item, ids);
    return [...new Set(ids)];
  }
  if (typeof value === "object") {
    if (typeof value.agent_id === "string") ids.push(value.agent_id);
    if (typeof value.agentId === "string") ids.push(value.agentId);
    for (const child of Object.values(value)) collectAgentIds(child, ids);
  }
  return [...new Set(ids)];
}

function outputLooksFailed(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function closeOutputLooksFailed(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return outputLooksFailed(value) || CLOSE_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function toolOutputLooksFailed(toolName, value) {
  return toolName === "close_agent" ? closeOutputLooksFailed(value) : outputLooksFailed(value);
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function extractPayload(record) {
  return record && typeof record === "object" && record.payload && typeof record.payload === "object"
    ? record.payload
    : {};
}

function canCarryRuntimeGuidance(record) {
  if (!record || typeof record !== "object") return false;
  if (record.type === "turn_context") return true;
  const payload = extractPayload(record);
  return record.type === "event_msg" && typeof payload.type === "string" && payload.type.startsWith("hook_");
}

function normalizeAgentToolName(name) {
  const text = typeof name === "string" ? name.trim().replace(/^functions\./, "") : "";
  const last = text.split(".").pop() || text;
  return ["spawn_agent", "close_agent", "send_input", "wait_agent"].includes(last) ? last : "";
}

function nestedToolInput(value) {
  if (!value || typeof value !== "object") return {};
  return value.parameters && typeof value.parameters === "object"
    ? value.parameters
    : value.arguments && typeof value.arguments === "object"
    ? value.arguments
    : {};
}

function collectNestedAgentOperations(value, operations = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedAgentOperations(item, operations);
    return operations;
  }
  if (!value || typeof value !== "object") return operations;

  const name = normalizeAgentToolName(value.recipient_name ?? value.recipientName ?? value.tool_name ?? value.toolName ?? value.name);
  if (name) operations.push({ name, args: nestedToolInput(value) });

  for (const key of ["tool_uses", "toolUses", "tools", "calls", "tool_calls", "toolCalls"]) {
    if (value[key]) collectNestedAgentOperations(value[key], operations);
  }
  return operations;
}

function readTranscript(text, sinceLine) {
  const markers = [];
  const calls = [];
  const spawnBatches = [];
  const outputsByCallId = new Map();
  const nestedCallIdsByWrapper = new Map();
  const lines = text.split(/\r?\n/);
  let sessionId = "";
  let pendingSpawnBatch = [];

  const flushSpawnBatch = () => {
    if (pendingSpawnBatch.length > 1) {
      spawnBatches.push([...pendingSpawnBatch]);
    }
    pendingSpawnBatch = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    if (!raw.trim()) continue;

    const record = safeJson(raw);
    if (!record) continue;
    const payload = extractPayload(record);
    if (record.type === "session_meta" && typeof payload.id === "string") sessionId = payload.id;
    if (Number.isFinite(sinceLine) && lineNumber < sinceLine) continue;

    if (canCarryRuntimeGuidance(record)) {
      for (const marker of GUIDANCE_MARKERS) {
        if (raw.includes(marker)) markers.push({ line: lineNumber, marker });
      }
    }

    if (record.type === "response_item" && payload.type === "function_call") {
      const name = normalizeAgentToolName(payload.name);
      if (name) {
        const args = parseCallArguments(payload.arguments);
        calls.push({
          line: lineNumber,
          call_id: typeof payload.call_id === "string" ? payload.call_id : "",
          wrapper_call_id: "",
          source: "direct",
          name,
          agent_type: args.agent_type ?? "",
          model: args.model ?? "",
          reasoning_effort: args.reasoning_effort ?? "",
          target: args.target ?? "",
          message_preview: preview(args.message),
          has_model: Boolean(args.model),
        });
        if (name === "spawn_agent") {
          pendingSpawnBatch.push(lineNumber);
        } else {
          flushSpawnBatch();
        }
      } else {
        const wrapperCallId = typeof payload.call_id === "string" ? payload.call_id : "";
        const nested = collectNestedAgentOperations(parseCallArguments(payload.arguments));
        const nestedIds = [];
        nested.forEach((operation, nestedIndex) => {
          const callId = wrapperCallId ? `${wrapperCallId}:nested:${nestedIndex}` : `line:${lineNumber}:nested:${nestedIndex}`;
          nestedIds.push(callId);
          const args = operation.args ?? {};
          calls.push({
            line: lineNumber,
            call_id: callId,
            wrapper_call_id: wrapperCallId,
            source: "nested",
            name: operation.name,
            agent_type: args.agent_type ?? "",
            model: args.model ?? "",
            reasoning_effort: args.reasoning_effort ?? "",
            target: args.target ?? "",
            message_preview: preview(args.message),
            has_model: Boolean(args.model),
          });
          if (operation.name === "spawn_agent") pendingSpawnBatch.push(lineNumber);
          else flushSpawnBatch();
        });
        if (wrapperCallId && nestedIds.length > 0) nestedCallIdsByWrapper.set(wrapperCallId, nestedIds);
      }
    } else if (record.type === "response_item" && payload.type === "function_call_output") {
      flushSpawnBatch();
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (callId) {
        const nestedCallIds = nestedCallIdsByWrapper.get(callId) ?? [];
        const nestedAgentIds = collectAgentIds(payload.output);
        nestedCallIds.forEach((nestedCallId, nestedIndex) => {
          outputsByCallId.set(nestedCallId, {
            line: lineNumber,
            output: payload.output,
            agent_id: nestedAgentIds.length === nestedCallIds.length ? nestedAgentIds[nestedIndex] : "",
            failed: outputLooksFailed(payload.output),
          });
        });
        outputsByCallId.set(callId, {
          line: lineNumber,
          output: payload.output,
          agent_id: parseOutputAgentId(payload.output),
          failed: outputLooksFailed(payload.output),
        });
      }
    }
  }
  flushSpawnBatch();

  return {
    sessionId,
    markers,
    spawnBatches,
    calls: calls.map((call) => {
      const output = outputsByCallId.get(call.call_id) ?? null;
      return {
        ...call,
        output: output
          ? { ...output, failed: toolOutputLooksFailed(call.name, output.output) }
          : null,
      };
    }),
  };
}

async function readEdges(dbPath, parent) {
  if (!dbPath || !parent || !(await exists(dbPath))) return { available: false, rows: [] };
  const query = [
    "select e.parent_thread_id, e.child_thread_id, e.status, t.agent_role, t.model, t.reasoning_effort, t.agent_nickname, t.title, t.updated_at",
    "from thread_spawn_edges e",
    "left join threads t on t.id = e.child_thread_id",
    `where e.parent_thread_id = ${sqlQuote(parent)}`,
    "order by coalesce(t.updated_at, 0) desc, e.child_thread_id;",
  ].join("\n");
  try {
    const dbStat = await stat(dbPath);
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, query], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { available: true, path: dbPath, bytes: dbStat.size, rows: safeJson(stdout.trim() || "[]") ?? [] };
  } catch (error) {
    return {
      available: false,
      path: dbPath,
      error: error instanceof Error ? error.message : String(error),
      rows: [],
    };
  }
}

function buildCheck(name, passed, evidence, severity = "fail") {
  return { name, status: passed ? "pass" : severity, evidence };
}

function summarizeChecks(checks) {
  if (checks.some((check) => check.status === "fail")) return "failed";
  if (checks.some((check) => check.status === "warn")) return "passed_with_warnings";
  return "passed";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.transcript) throw new Error("--transcript is required");

  const transcriptPath = resolve(args.transcript);
  const transcript = readTranscript(await readFile(transcriptPath, "utf-8"), args.sinceLine);
  const parent = args.parent || transcript.sessionId;
  const dbPath = args.stateDb || await defaultStateDb();
  const edges = await readEdges(dbPath ? resolve(dbPath) : "", parent);
  const spawnCalls = transcript.calls.filter((call) => call.name === "spawn_agent");
  const spawnBatches = transcript.spawnBatches ?? [];
  const failedSpawnCalls = spawnCalls.filter((call) => call.output?.failed);
  const spawnCallsMissingOutput = spawnCalls.filter((call) => !call.output);
  const missingModelSpawns = spawnCalls.filter((call) => !call.has_model);
  const missingModelCreated = missingModelSpawns.filter((call) => call.output?.agent_id && !call.output.failed);
  const earliestSpawnLine = spawnCalls.reduce((line, call) => Math.min(line, call.line), Number.POSITIVE_INFINITY);
  const guidanceBeforeFirstSpawn = transcript.markers.some((marker) => marker.line < earliestSpawnLine);
  const edgeByChild = new Map(edges.rows.map((row) => [row.child_thread_id, row]));
  const successfulSpawns = spawnCalls.filter((call) => call.output?.agent_id && !call.output.failed);
  const closeTargetSet = new Set(
    transcript.calls
      .filter((call) => call.name === "close_agent" && call.target && call.output && !call.output.failed)
      .map((call) => call.target),
  );
  const openRows = edges.rows.filter((row) => row.status === "open");
  const spawnReports = successfulSpawns.map((call) => {
    const edge = edgeByChild.get(call.output.agent_id) ?? null;
    return {
      call,
      edge,
      tool_model_matches_native: Boolean(call.model && edge?.model === call.model),
      closed: Boolean(edge?.status === "closed" && closeTargetSet.has(call.output.agent_id)),
    };
  });
  const expectedModels = Array.isArray(args.expectModels) ? args.expectModels.filter(Boolean) : [];
  const checks = [
    buildCheck(
      "native_db_available",
      edges.available,
      edges.available ? `state_db=${edges.path}` : (edges.error || "state DB unavailable"),
    ),
    buildCheck(
      "no_missing_model_spawn_created",
      missingModelCreated.length === 0,
      missingModelCreated.length === 0
        ? "no missing-model spawn created a child"
        : missingModelCreated.map((call) => `line ${call.line} -> ${call.output?.agent_id}`).join(", "),
    ),
    buildCheck(
      "spawn_outputs_observed",
      spawnCallsMissingOutput.length === 0,
      spawnCallsMissingOutput.length === 0
        ? "every scanned spawn_agent call has a matched output"
        : spawnCallsMissingOutput.map((call) => `line ${call.line} (${call.source})`).join(", "),
    ),
    buildCheck(
      "no_spawn_failures",
      failedSpawnCalls.length === 0,
      failedSpawnCalls.length === 0
        ? "no spawn_agent calls returned runtime/tool failure"
        : failedSpawnCalls.map((call) => `line ${call.line} -> output line ${call.output?.line ?? "?"}`).join(", "),
    ),
    buildCheck(
      "guidance_before_first_spawn",
      spawnCalls.length === 0 || guidanceBeforeFirstSpawn || args.allowMissingGuidance || !args.requireGuidance,
      guidanceBeforeFirstSpawn
        ? `first marker line=${transcript.markers.find((marker) => marker.line < earliestSpawnLine)?.line}`
        : "no advisor guidance marker found before first scanned spawn",
      args.requireGuidance && !args.allowMissingGuidance ? "fail" : "warn",
    ),
    ...expectedModels.map((model) => {
      const matches = spawnReports.filter((report) => report.call.model === model && report.edge?.model === model);
      return buildCheck(
        `model_recorded:${model}`,
        matches.length > 0,
        matches.length > 0
          ? matches.map((report) => `${report.call.output.agent_id}:${report.edge.agent_role}/${report.edge.reasoning_effort}/${report.edge.status}`).join(", ")
          : `no successful spawn with tool input and native DB model=${model}`,
      );
    }),
  ];
  if (Number.isFinite(args.expectCurrentOpen)) {
    checks.push(buildCheck(
      "current_parent_open_count",
      openRows.length === args.expectCurrentOpen,
      `open=${openRows.length}, expected=${args.expectCurrentOpen}`,
    ));
  }
  if (args.expectAllClosed) {
    const notClosed = spawnReports.filter((report) => !report.closed);
    checks.push(buildCheck(
      "successful_spawns_closed",
      notClosed.length === 0,
      notClosed.length === 0
        ? "every successful spawn in the scanned window has a successful close and closed native edge"
        : notClosed.map((report) => `${report.call.output.agent_id}:edge=${report.edge?.status ?? "missing"}, close=${closeTargetSet.has(report.call.output.agent_id)}`).join(", "),
    ));
  }
  const checkStatus = summarizeChecks(checks);

  const result = {
    ok: checkStatus !== "failed",
    verdict: checkStatus === "failed" && missingModelCreated.length > 0
      ? "native_spawn_missing_model_bypassed_advisor"
      : checkStatus === "failed"
      ? "live_check_failed"
      : spawnCalls.length > 0 && !guidanceBeforeFirstSpawn
      ? "live_check_passed_without_transcript_guidance"
      : "no_bypass_detected_in_scanned_window",
    check_status: checkStatus,
    checks,
    transcript_path: transcriptPath,
    parent_thread_id: parent,
    scanned_since_line: Number.isFinite(args.sinceLine) ? args.sinceLine : 1,
    guidance_markers: transcript.markers,
    spawn_batches: spawnBatches,
    spawn_calls: spawnCalls.map((call) => ({
      line: call.line,
      call_id: call.call_id,
      wrapper_call_id: call.wrapper_call_id || null,
      source: call.source,
      agent_type: call.agent_type,
      model: call.model || null,
      reasoning_effort: call.reasoning_effort || null,
      has_model: call.has_model,
      output_line: call.output?.line ?? null,
      created_agent_id: call.output?.agent_id || null,
      output_failed: call.output?.failed ?? null,
      native_edge: call.output?.agent_id ? edgeByChild.get(call.output.agent_id) ?? null : null,
      message_preview: call.message_preview,
    })),
    model_routes: spawnReports.map((report) => ({
      child_thread_id: report.call.output.agent_id,
      tool_model: report.call.model || null,
      native_model: report.edge?.model ?? null,
      agent_type: report.call.agent_type || null,
      native_role: report.edge?.agent_role ?? null,
      reasoning_effort: report.edge?.reasoning_effort ?? report.call.reasoning_effort ?? null,
      native_status: report.edge?.status ?? null,
      tool_model_matches_native: report.tool_model_matches_native,
      closed_after_spawn: report.closed,
    })),
    close_calls: transcript.calls.filter((call) => call.name === "close_agent").map((call) => ({
      line: call.line,
      source: call.source,
      target: call.target,
      output_line: call.output?.line ?? null,
      output_failed: call.output?.failed ?? null,
    })),
    state_db: edges,
    interpretation: [
      "ok=false means this real transcript contains a native spawn path that was not protected by the advisor before the child was created.",
      "This check is read-only; it proves observed runtime behavior from transcript and SQLite evidence, not synthetic hook behavior.",
    ],
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ROUTE_CARRIER_BY_NAME } from "../hooks/native-agent-route-profiles.mjs";

const execFileAsync = promisify(execFile);

function usage() {
  return [
    "Usage: node scripts/live-check.mjs --transcript <path> [options]",
    "  --state-db <path>             Codex SQLite DB; defaults to $CODEX_HOME/state_5.sqlite.",
    "  --parent <thread_id>          Parent id; defaults to transcript session_meta id.",
    "  --expect-model <model>        Require a successful native child on this route. Repeatable.",
    "  --expect-current-open <n>     Require exact current-parent non-closed edge count.",
    "",
    "Read-only audit. It never creates, closes, repairs, or archives a child.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { expectModels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--transcript") args.transcript = argv[++index];
    else if (value === "--state-db") args.stateDb = argv[++index];
    else if (value === "--parent") args.parent = argv[++index];
    else if (value === "--expect-model") args.expectModels.push(argv[++index]);
    else if (value === "--expect-current-open") args.expectCurrentOpen = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function argumentsObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return typeof value === "string" ? safeJson(value) ?? {} : {};
}

function explicit(value) {
  return safeString(value).trim().toLowerCase();
}

function outputText(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function forkContext(args) {
  const value = args.fork_context ?? args.forkContext;
  return value === true || explicit(value) === "true";
}

function outputAgentId(value) {
  return outputAgentIds(value)[0] ?? "";
}

function outputAgentIds(value) {
  const ids = [];
  const visit = (current) => {
    if (typeof current === "string") {
      for (const match of current.matchAll(/"agent_id"\s*:\s*"([^"]+)"/g)) ids.push(match[1]);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    if (typeof current.agent_id === "string") ids.push(current.agent_id);
    Object.entries(current).forEach(([key, nested]) => {
      if (key !== "agent_id") visit(nested);
    });
  };
  visit(typeof value === "string" ? safeJson(value) ?? value : value);
  return ids;
}

function outputFailed(value) {
  return /(?:unable|cannot|failed) to spawn|agent.*limit|pool.*full|agent type is currently not available/i.test(outputText(value));
}

function embeddedSpawnArguments(source) {
  const calls = [];
  const pattern = /tools\.multi_agent_v1__spawn_agent\s*\(\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const remainder = source.slice(match.index, match.index + 4096);
    const messageStart = remainder.search(/\b(?:message|items)\s*:/);
    const header = messageStart >= 0 ? remainder.slice(0, messageStart) : remainder;
    const property = (name) => header.match(new RegExp(`\\b${name}\\s*:\\s*["']([^"']+)["']`))?.[1] ?? "";
    const fork = header.match(/\bfork_context\s*:\s*(true|false)/)?.[1];
    calls.push({
      agent_type: property("agent_type"),
      model: property("model"),
      reasoning_effort: property("reasoning_effort"),
      ...(fork ? { fork_context: fork === "true" } : {}),
    });
  }
  return calls;
}

function buildCheck(name, ok, detail) {
  return { name, ok, detail };
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultStateDb() {
  const home = safeString(process.env.CODEX_HOME).trim() || (safeString(process.env.HOME).trim() ? join(process.env.HOME, ".codex") : "");
  return home ? join(home, "state_5.sqlite") : "";
}

async function readEdges(dbPath, parent) {
  if (!dbPath || !parent || !(await exists(dbPath))) return { available: false, rows: [] };
  const sql = [
    "select e.child_thread_id,e.status,t.model,t.reasoning_effort",
    "from thread_spawn_edges e left join threads t on t.id=e.child_thread_id",
    `where e.parent_thread_id='${parent.replace(/'/g, "''")}'`,
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 2000, maxBuffer: 1024 * 1024 });
    return { available: true, rows: JSON.parse(stdout.trim() || "[]") };
  } catch {
    return { available: false, rows: [] };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.transcript) throw new Error("--transcript is required");
  const lines = (await readFile(args.transcript, "utf-8")).split(/\r?\n/);
  const calls = new Map();
  const embeddedCalls = new Map();
  const spawns = [];
  const legacyFailures = [];
  let parent = safeString(args.parent).trim();
  for (const [index, line] of lines.entries()) {
    const record = safeJson(line);
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (!parent && record.type === "session_meta") parent = safeString(payload.id).trim();
    if (record.type !== "response_item") continue;
    if (payload.type === "function_call" && /(?:^|__)spawn_agent$/.test(safeString(payload.name))) {
      const call = { line: index + 1, callId: safeString(payload.call_id).trim(), args: argumentsObject(payload.arguments), output: null };
      spawns.push(call);
      if (call.callId) calls.set(call.callId, call);
    }
    if (payload.type === "custom_tool_call" && payload.name === "exec") {
      const embedded = embeddedSpawnArguments(safeString(payload.input));
      if (embedded.length > 0) {
        const callId = safeString(payload.call_id).trim();
        const nested = embedded.map((args) => ({ line: index + 1, callId, args, output: null, embedded: true, unattributed: false }));
        spawns.push(...nested);
        if (callId) embeddedCalls.set(callId, nested);
      }
    }
    if (payload.type === "function_call_output") {
      if (/\blive agent path\b[^\n\r]{0,240}\bnot found\b/i.test(outputText(payload.output))) legacyFailures.push(index + 1);
      const call = calls.get(safeString(payload.call_id).trim());
      if (call) call.output = payload.output;
    }
    if (payload.type === "custom_tool_call_output") {
      const nested = embeddedCalls.get(safeString(payload.call_id).trim());
      if (nested) {
        const ids = outputAgentIds(payload.output);
        for (const [nestedIndex, call] of nested.entries()) {
          if (ids[nestedIndex]) call.output = { agent_id: ids[nestedIndex] };
          else call.unattributed = true;
        }
        if (ids.length !== nested.length) nested.forEach((call) => { call.unattributed = true; });
      }
    }
  }
  const invalid = spawns.filter((call) => forkContext(call.args)
    || !explicit(call.args.model)
    || !explicit(call.args.reasoning_effort ?? call.args.reasoningEffort));
  const carrierViolations = spawns.filter((call) => {
    const carrier = ROUTE_CARRIER_BY_NAME.get(explicit(call.args.agent_type ?? call.args.agentType));
    return !carrier || explicit(call.args.model) !== carrier.model;
  });
  const successful = spawns.filter((call) => call.output && !outputFailed(call.output) && outputAgentId(call.output));
  const unattributed = spawns.filter((call) => call.unattributed === true);
  const db = await readEdges(args.stateDb || defaultStateDb(), parent);
  const edgeById = new Map(db.rows.map((row) => [safeString(row?.child_thread_id).trim(), row]));
  const routeMismatches = successful.filter((call) => {
    const edge = edgeById.get(outputAgentId(call.output));
    return !edge || explicit(edge.model) !== explicit(call.args.model) || explicit(edge.reasoning_effort) !== explicit(call.args.reasoning_effort ?? call.args.reasoningEffort);
  });
  const routeProofAvailable = successful.length === 0 || db.available;
  const routeMatches = routeProofAvailable && routeMismatches.length === 0;
  const checks = [
    buildCheck("no_legacy_followup_failure", legacyFailures.length === 0, legacyFailures.length ? `lines ${legacyFailures.join(",")}` : "none"),
    buildCheck("all_spawn_routes_explicit", invalid.length === 0, invalid.length ? `lines ${invalid.map((call) => call.line).join(",")}` : "all explicit"),
    buildCheck("carrier_route_contract", carrierViolations.length === 0, carrierViolations.length ? `lines ${carrierViolations.map((call) => call.line).join(",")}` : "all carriers match their model"),
    buildCheck("all_embedded_spawns_attributed", unattributed.length === 0, unattributed.length ? `lines ${unattributed.map((call) => call.line).join(",")}` : "all attributed"),
    buildCheck("no_runtime_spawn_failure", spawns.every((call) => !call.output || !outputFailed(call.output)), "runtime output inspected"),
    buildCheck("native_route_matches_transcript", routeMatches, !routeProofAvailable ? "native DB unavailable for successful spawn" : (routeMismatches.length ? `children ${routeMismatches.map((call) => outputAgentId(call.output)).join(",")}` : "all matched")),
  ];
  for (const model of args.expectModels.map(explicit).filter(Boolean)) {
    checks.push(buildCheck(`expected_model:${model}`, successful.some((call) => explicit(call.args.model) === model), "successful transcript spawn required"));
  }
  const open = db.rows.filter((row) => explicit(row?.status) !== "closed").length;
  if (Number.isInteger(args.expectCurrentOpen)) checks.push(buildCheck("expected_current_open", db.available && open === args.expectCurrentOpen, `actual=${db.available ? open : "unavailable"}`));
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, parent: parent || null, checks, spawns: spawns.map((call) => ({ line: call.line, embedded: call.embedded === true, agent_type: call.args.agent_type ?? call.args.agentType ?? null, model: call.args.model ?? null, reasoning_effort: call.args.reasoning_effort ?? call.args.reasoningEffort ?? null, child_id: outputAgentId(call.output) || null })), current_parent_open: db.available ? open : null }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

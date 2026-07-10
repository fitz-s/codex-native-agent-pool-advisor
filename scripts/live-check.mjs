#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

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
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (parsed && typeof parsed === "object" && typeof parsed.agent_id === "string") return parsed.agent_id;
  return outputText(value).match(/"agent_id"\s*:\s*"([^"]+)"/)?.[1] ?? "";
}

function outputFailed(value) {
  return /(?:unable|cannot|failed) to spawn|agent.*limit|pool.*full|agent type is currently not available/i.test(outputText(value));
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
  const spawns = [];
  const legacyFailures = [];
  let parent = safeString(args.parent).trim();
  for (const [index, line] of lines.entries()) {
    const record = safeJson(line);
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (!parent && record.type === "session_meta") parent = safeString(payload.id).trim();
    if (record.type !== "response_item") continue;
    if (payload.type === "function_call" && payload.name === "spawn_agent") {
      const call = { line: index + 1, callId: safeString(payload.call_id).trim(), args: argumentsObject(payload.arguments), output: null };
      spawns.push(call);
      if (call.callId) calls.set(call.callId, call);
    }
    if (payload.type === "function_call_output") {
      if (/\blive agent path\b[^\n\r]{0,240}\bnot found\b/i.test(outputText(payload.output))) legacyFailures.push(index + 1);
      const call = calls.get(safeString(payload.call_id).trim());
      if (call) call.output = payload.output;
    }
  }
  const invalid = spawns.filter((call) => {
    const model = explicit(call.args.model);
    const effort = explicit(call.args.reasoning_effort ?? call.args.reasoningEffort);
    return forkContext(call.args) || !MODELS.has(model) || !EFFORTS.has(effort);
  });
  const successful = spawns.filter((call) => call.output && !outputFailed(call.output) && outputAgentId(call.output));
  const db = await readEdges(args.stateDb || defaultStateDb(), parent);
  const edgeById = new Map(db.rows.map((row) => [safeString(row?.child_thread_id).trim(), row]));
  const routeMismatches = successful.filter((call) => {
    const edge = edgeById.get(outputAgentId(call.output));
    return !edge || explicit(edge.model) !== explicit(call.args.model) || explicit(edge.reasoning_effort) !== explicit(call.args.reasoning_effort ?? call.args.reasoningEffort);
  });
  const checks = [
    buildCheck("no_legacy_followup_failure", legacyFailures.length === 0, legacyFailures.length ? `lines ${legacyFailures.join(",")}` : "none"),
    buildCheck("all_spawn_routes_explicit", invalid.length === 0, invalid.length ? `lines ${invalid.map((call) => call.line).join(",")}` : "all explicit"),
    buildCheck("no_runtime_spawn_failure", spawns.every((call) => !call.output || !outputFailed(call.output)), "runtime output inspected"),
    buildCheck("native_route_matches_transcript", routeMismatches.length === 0, db.available ? (routeMismatches.length ? `children ${routeMismatches.map((call) => outputAgentId(call.output)).join(",")}` : "all matched") : "native DB unavailable"),
  ];
  for (const model of args.expectModels.map(explicit).filter(Boolean)) {
    checks.push(buildCheck(`expected_model:${model}`, successful.some((call) => explicit(call.args.model) === model), "successful transcript spawn required"));
  }
  const open = db.rows.filter((row) => explicit(row?.status) !== "closed").length;
  if (Number.isInteger(args.expectCurrentOpen)) checks.push(buildCheck("expected_current_open", db.available && open === args.expectCurrentOpen, `actual=${db.available ? open : "unavailable"}`));
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, parent: parent || null, checks, spawns: spawns.map((call) => ({ line: call.line, model: call.args.model ?? null, reasoning_effort: call.args.reasoning_effort ?? call.args.reasoningEffort ?? null, child_id: outputAgentId(call.output) || null })), current_parent_open: db.available ? open : null }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

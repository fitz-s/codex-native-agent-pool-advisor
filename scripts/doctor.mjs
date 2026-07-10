#!/usr/bin/env node

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHook = join(repoRoot, "hooks", "native-agent-pool-advisor.mjs");
const ACTIVE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostCompact", "SubagentStop"];
const RETIRED_EVENTS = ["PostToolUse", "PreCompact"];
const LEGACY_HOOK_COMMANDS = [
  /(?:^|[\\/])oh-my-codex[\\/]dist[\\/]scripts[\\/]codex-native-hook\.js(?:["'\s]|$)/i,
  /(?:^|[\\/])quiet-omx-status-self-heal\.mjs(?:["'\s]|$)/i,
];

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "";
  }
}

function isAdvisorHookCommand(hook) {
  return hook && hook.type === "command" && typeof hook.command === "string" && hook.command.includes("native-agent-pool-advisor.mjs");
}

function countHookCommand(config, eventName) {
  const entries = Array.isArray(config?.hooks?.[eventName]) ? config.hooks[eventName] : [];
  return entries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : []).filter(isAdvisorHookCommand).length;
}

function legacyOrchestrationHooks(config) {
  const found = [];
  for (const [eventName, entries] of Object.entries(config?.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (hook?.type !== "command" || typeof hook.command !== "string") continue;
        if (LEGACY_HOOK_COMMANDS.some((pattern) => pattern.test(hook.command))) {
          found.push({ event: eventName, command: hook.command });
        }
      }
    }
  }
  return found;
}

async function nativeEdgeCount(dbPath) {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, "select count(*) from thread_spawn_edges;"], { timeout: 2000, maxBuffer: 1024 * 1024 });
    const count = Number(stdout.trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function main() {
  const home = codexHome();
  const hooksPath = join(home, "hooks.json");
  const installedHook = join(home, "hooks", "native-agent-pool-advisor.mjs");
  const dbPath = join(home, "state_5.sqlite");
  let config = {};
  try {
    config = JSON.parse(await readFile(hooksPath, "utf-8"));
  } catch {
    config = {};
  }
  const registrations = Object.fromEntries(ACTIVE_EVENTS.map((eventName) => [eventName, countHookCommand(config, eventName)]));
  const retiredRegistrations = Object.fromEntries(RETIRED_EVENTS.map((eventName) => [eventName, countHookCommand(config, eventName)]));
  const legacyHooks = legacyOrchestrationHooks(config);
  const checks = {
    codex_home: home,
    hooks_json_exists: await pathExists(hooksPath),
    installed_hook_exists: await pathExists(installedHook),
    installed_hook_matches_repo: (await sha256(installedHook)) === (await sha256(sourceHook)),
    registrations,
    retired_registrations: retiredRegistrations,
    legacy_orchestration_hooks: legacyHooks,
    state_db_path: dbPath,
    state_db_exists: await pathExists(dbPath),
    state_db_bytes: await pathExists(dbPath) ? (await stat(dbPath)).size : null,
    thread_spawn_edges_count: await nativeEdgeCount(dbPath),
    native_db_write_policy: "read_only",
    legacy_global_state_watcher: "retired",
  };
  const ok = checks.hooks_json_exists
    && checks.installed_hook_exists
    && checks.installed_hook_matches_repo
    && ACTIVE_EVENTS.every((eventName) => registrations[eventName] === 1)
    && RETIRED_EVENTS.every((eventName) => retiredRegistrations[eventName] === 0)
    && legacyHooks.length === 0;
  process.stdout.write(`${JSON.stringify({
    ok,
    checks,
    runtime_capabilities: {
      registration_verified_only: true,
      native_spawn_pre_tool_use_hard_block: "not_documented",
      native_spawn_control_plane: "read-only PreToolUse admission when Codex emits it",
      lifecycle_authority: "Codex runtime only",
      route_audit: "live-check reads transcripts; hook never infers a route from role or parent",
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

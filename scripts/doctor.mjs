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
const sourceWatcher = join(repoRoot, "scripts", "global-state-watch.mjs");
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact"];
const WATCHER_LABEL = "com.fitz.codex-native-agent-pool-global-state-watch";
const RUNTIME_CAPABILITIES = {
  registration_verified_only: true,
  pre_tool_use_documented_targets: ["Bash", "apply_patch", "MCP tools"],
  native_spawn_pre_tool_use_hard_block: "not_documented",
  native_spawn_control_plane: "SessionStart/UserPromptSubmit/PreCompact/PostCompact guidance plus PostToolUse reconciliation when Codex emits those events",
  e2e_native_spawn_block_requires_live_check: true,
};

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readFirstString(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function readAdvisorConfig(home) {
  return safeObject(await readJson(join(home, "native-agent-pool-advisor.config.json"))) ?? {};
}

function stateDbPath(home, config) {
  const paths = safeObject(config.paths) ?? {};
  const override = readFirstString(
    process.env.NATIVE_AGENT_POOL_STATE_DB_PATH,
    paths.state_db_path,
    paths.stateDbPath,
  );
  if (override) return override;
  const name = readFirstString(
    process.env.NATIVE_AGENT_POOL_STATE_DB_NAME,
    paths.state_db_name,
    paths.stateDbName,
    "state_5.sqlite",
  );
  return join(home, name);
}

function defaultCodexHome() {
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, ".codex") : "";
}

function watcherTarget(home) {
  return join(home, "hooks", "native-agent-pool-global-state-watch.mjs");
}

function launchAgentPath() {
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, "Library", "LaunchAgents", `${WATCHER_LABEL}.plist`) : "";
}

function watcherApplicable(home) {
  return process.platform === "darwin" && home === defaultCodexHome();
}

async function launchdServiceRunning() {
  if (process.platform !== "darwin") return null;
  try {
    await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/${WATCHER_LABEL}`], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
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
  return hook
    && hook.type === "command"
    && typeof hook.command === "string"
    && hook.command.includes("native-agent-pool-advisor.mjs");
}

function countHookCommand(config, eventName) {
  const entries = Array.isArray(config?.hooks?.[eventName]) ? config.hooks[eventName] : [];
  return entries
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter((hook) => isAdvisorHookCommand(hook)).length;
}

async function sqliteCount(dbPath) {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, "select count(*) from thread_spawn_edges;"], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const count = Number(stdout.trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function sqliteTableColumns(dbPath, tableName) {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, `pragma table_info(${tableName});`], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const rows = JSON.parse(stdout.trim() || "[]");
    return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.name ?? "").trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function sqliteUnsupportedModelCount(dbPath) {
  const sql = `
WITH cols AS (
  SELECT name FROM pragma_table_info('threads')
),
required AS (
  SELECT
    EXISTS(SELECT 1 FROM cols WHERE name='archived') AS has_archived,
    EXISTS(SELECT 1 FROM cols WHERE name='model_provider') AS has_model_provider,
    EXISTS(SELECT 1 FROM cols WHERE name='model') AS has_model
)
SELECT CASE
  WHEN (SELECT has_archived AND has_model_provider AND has_model FROM required) = 0 THEN -1
  ELSE (
    SELECT count(*)
    FROM threads
    WHERE archived=0
      AND thread_source='subagent'
      AND (
        model_provider!='openai'
        OR model IS NULL
        OR trim(model)=''
        OR trim(model) IN ('codex','cx/gpt-5.6-terra','gh/gpt-5.6-sol')
        OR trim(model) NOT IN ('gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol')
      )
  )
END;
`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, sql], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const count = Number(stdout.trim());
    if (count === -1) return null;
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function sqliteStaleOrphanVisibleSubagentCount(dbPath) {
  const columns = await sqliteTableColumns(dbPath, "threads");
  if (!columns.has("archived") || !columns.has("updated_at")) return null;
  const subagentPredicates = [];
  if (columns.has("thread_source")) subagentPredicates.push("t.thread_source='subagent'");
  if (columns.has("source")) subagentPredicates.push("t.source like '%\"parent_thread_id\"%'");
  if (subagentPredicates.length === 0) return null;
  const cutoffSeconds = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const sql = `
SELECT count(*)
FROM threads t
WHERE coalesce(t.archived,0)=0
  AND coalesce(t.updated_at,0)>0
  AND t.updated_at<${cutoffSeconds}
  AND (${subagentPredicates.join(" OR ")})
  AND NOT EXISTS (
    SELECT 1 FROM thread_spawn_edges e
    WHERE e.child_thread_id=t.id
  );
`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, sql], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const count = Number(stdout.trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function sqliteArchivedOpenEdgeThreadCount(dbPath) {
  const columns = await sqliteTableColumns(dbPath, "threads");
  if (!columns.has("archived")) return null;
  const sql = `
SELECT count(*)
FROM thread_spawn_edges e
JOIN threads t ON t.id=e.child_thread_id
WHERE e.status='open'
  AND coalesce(t.archived,0)=1;
`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, sql], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const count = Number(stdout.trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function main() {
  const home = codexHome();
  const advisorConfig = await readAdvisorConfig(home);
  const installedHook = join(home, "hooks", "native-agent-pool-advisor.mjs");
  const installedWatcher = watcherTarget(home);
  const plistPath = launchAgentPath();
  const hooksPath = join(home, "hooks.json");
  const statePath = join(home, "state", "native-agent-pool-advisor.json");
  const dbPath = stateDbPath(home, advisorConfig);
  const hooksConfig = await readJson(hooksPath);
  const installedHash = await sha256(installedHook);
  const sourceHash = await sha256(sourceHook);
  const installedWatcherHash = await sha256(installedWatcher);
  const sourceWatcherHash = await sha256(sourceWatcher);
  const dbStats = (await pathExists(dbPath)) ? await stat(dbPath) : null;

  const registrations = Object.fromEntries(
    EVENTS.map((eventName) => [eventName, countHookCommand(hooksConfig, eventName)]),
  );
  const checks = {
    codex_home: home,
    hooks_json_exists: await pathExists(hooksPath),
    installed_hook_exists: await pathExists(installedHook),
    installed_hook_matches_repo: Boolean(installedHash && sourceHash && installedHash === sourceHash),
    global_state_watcher_applicable: watcherApplicable(home),
    global_state_watcher_exists: await pathExists(installedWatcher),
    global_state_watcher_matches_repo: Boolean(installedWatcherHash && sourceWatcherHash && installedWatcherHash === sourceWatcherHash),
    global_state_watcher_launch_agent_exists: plistPath ? await pathExists(plistPath) : false,
    global_state_watcher_launchd_running: watcherApplicable(home) ? await launchdServiceRunning() : null,
    registrations,
    state_file_exists: await pathExists(statePath),
    state_db_path: dbPath,
    state_db_exists: Boolean(dbStats),
    state_db_bytes: dbStats?.size ?? 0,
    thread_spawn_edges_count: dbStats ? await sqliteCount(dbPath) : null,
    unsupported_unarchived_thread_models_count: dbStats ? await sqliteUnsupportedModelCount(dbPath) : null,
    unsupported_unarchived_thread_models_scope: "diagnostic_only: parent-scoped admission ignores historical rows from other sessions",
    stale_orphan_visible_subagent_threads_count: dbStats ? await sqliteStaleOrphanVisibleSubagentCount(dbPath) : null,
    archived_open_edge_threads_count: dbStats ? await sqliteArchivedOpenEdgeThreadCount(dbPath) : null,
  };
  const ok = checks.hooks_json_exists
    && checks.installed_hook_exists
    && checks.installed_hook_matches_repo
    && EVENTS.every((eventName) => registrations[eventName] === 1)
    && checks.state_db_exists
    && checks.thread_spawn_edges_count !== null
    && (checks.stale_orphan_visible_subagent_threads_count === null
      || checks.stale_orphan_visible_subagent_threads_count === 0)
    && (checks.archived_open_edge_threads_count === null
      || checks.archived_open_edge_threads_count === 0);

  process.stdout.write(`${JSON.stringify({ ok, checks, runtime_capabilities: RUNTIME_CAPABILITIES }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

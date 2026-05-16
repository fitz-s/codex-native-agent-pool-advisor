#!/usr/bin/env node

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrDefault(path, fallback) {
  if (!(await pathExists(path))) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

function parseArgs(argv) {
  const args = { parent: "", global: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--parent") args.parent = String(argv[++i] ?? "").trim();
    else if (arg === "--global") args.global = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.global && !args.parent) {
    throw new Error("reset requires --parent <thread_id> or --global");
  }
  if (args.global && args.parent) {
    throw new Error("choose only one of --parent or --global");
  }
  return args;
}

async function sqliteJson(dbPath, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    const lastArray = text.lastIndexOf("\n[");
    return JSON.parse(lastArray >= 0 ? text.slice(lastArray + 1) : "[]");
  }
}

async function markReset(home, parent, resetAt) {
  const path = join(home, "state", "native-agent-pool-advisor.json");
  const state = await readJsonOrDefault(path, {
    version: 1,
    sessions: {},
    native_pool_reset_threads: {},
    native_pool_pruned_parent_at: {},
  });
  state.version = 1;
  state.updated_at = resetAt;
  state.native_pool_reset_threads =
    state.native_pool_reset_threads && typeof state.native_pool_reset_threads === "object"
      ? state.native_pool_reset_threads
      : {};
  state.native_pool_pruned_parent_at =
    state.native_pool_pruned_parent_at && typeof state.native_pool_pruned_parent_at === "object"
      ? state.native_pool_pruned_parent_at
      : {};
  if (parent) state.native_pool_reset_threads[parent] = resetAt;
  else state.last_native_pool_reset_at = resetAt;
  await writeJsonAtomic(path, state);
}

async function appendLog(home, record) {
  const path = join(home, "log", "native-agent-pool-advisor.log");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
    flag: "a",
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: reset-pool.mjs (--parent <thread_id> | --global) [--dry-run]\n");
    return;
  }

  const home = codexHome();
  const dbPath = join(home, "state_5.sqlite");
  if (!(await pathExists(dbPath))) throw new Error(`missing Codex state DB: ${dbPath}`);

  const where = args.parent ? `where parent_thread_id=${sqlString(args.parent)}` : "";
  const before = await sqliteJson(dbPath, `select status,count(*) as count from thread_spawn_edges ${where} group by status order by status;`);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ dry_run: true, parent: args.parent || null, before }, null, 2)}\n`);
    return;
  }

  const resetAt = new Date().toISOString();
  const backupPath = `${dbPath}.backup-native-agent-pool-reset-${resetAt.replace(/[-:.]/g, "").replace("T", "T").replace("Z", "Z")}`;
  await copyFile(dbPath, backupPath);

  const deleteSql = [
    "pragma busy_timeout=1000;",
    "create index if not exists idx_thread_spawn_edges_parent_status on thread_spawn_edges(parent_thread_id,status);",
    `delete from thread_spawn_edges ${where};`,
    "select changes() as changed;",
  ].join(" ");
  const changedRows = await sqliteJson(dbPath, deleteSql);
  await markReset(home, args.parent, resetAt);
  await appendLog(home, {
    event: "explicit_native_pool_reset",
    parent_thread_id: args.parent || null,
    backup: backupPath,
    before,
    changed: Number(changedRows?.[0]?.changed ?? 0),
    reset_at: resetAt,
  });

  process.stdout.write(`${JSON.stringify({ reset_at: resetAt, backup: backupPath, parent: args.parent || null, before, changed: Number(changedRows?.[0]?.changed ?? 0) }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

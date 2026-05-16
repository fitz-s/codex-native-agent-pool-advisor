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
const EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse"];

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

function hookCommand(home) {
  return `node "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"`;
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

async function sha256(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "";
  }
}

function countHookCommand(config, eventName, command) {
  const entries = Array.isArray(config?.hooks?.[eventName]) ? config.hooks[eventName] : [];
  return entries
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter((hook) => hook?.type === "command" && hook.command === command).length;
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

async function main() {
  const home = codexHome();
  const installedHook = join(home, "hooks", "native-agent-pool-advisor.mjs");
  const hooksPath = join(home, "hooks.json");
  const statePath = join(home, "state", "native-agent-pool-advisor.json");
  const dbPath = join(home, "state_5.sqlite");
  const hooksConfig = await readJson(hooksPath);
  const command = hookCommand(home);
  const installedHash = await sha256(installedHook);
  const sourceHash = await sha256(sourceHook);
  const dbStats = (await pathExists(dbPath)) ? await stat(dbPath) : null;

  const registrations = Object.fromEntries(
    EVENTS.map((eventName) => [eventName, countHookCommand(hooksConfig, eventName, command)]),
  );
  const checks = {
    codex_home: home,
    hooks_json_exists: await pathExists(hooksPath),
    installed_hook_exists: await pathExists(installedHook),
    installed_hook_matches_repo: Boolean(installedHash && sourceHash && installedHash === sourceHash),
    registrations,
    state_file_exists: await pathExists(statePath),
    state_db_exists: Boolean(dbStats),
    state_db_bytes: dbStats?.size ?? 0,
    thread_spawn_edges_count: dbStats ? await sqliteCount(dbPath) : null,
  };
  const ok = checks.hooks_json_exists
    && checks.installed_hook_exists
    && checks.installed_hook_matches_repo
    && EVENTS.every((eventName) => registrations[eventName] === 1)
    && checks.state_db_exists
    && checks.thread_spawn_edges_count !== null;

  process.stdout.write(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

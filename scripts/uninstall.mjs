#!/usr/bin/env node

import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact"];
const WATCHER_LABEL = "com.fitz.codex-native-agent-pool-global-state-watch";

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

function watcherTarget(home) {
  return join(home, "hooks", "native-agent-pool-global-state-watch.mjs");
}

function launchAgentPath() {
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, "Library", "LaunchAgents", `${WATCHER_LABEL}.plist`) : "";
}

function defaultCodexHome() {
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, ".codex") : "";
}

function shouldManageLaunchd(home) {
  if (process.env.NATIVE_AGENT_POOL_SKIP_WATCHER === "1") return false;
  if (process.env.NATIVE_AGENT_POOL_INSTALL_WATCHER === "1") return process.platform === "darwin";
  return process.platform === "darwin" && home === defaultCodexHome();
}

async function runLaunchctl(args) {
  try {
    await execFileAsync("launchctl", args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
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
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

function parseArgs(argv) {
  const args = { dryRun: false, removeHookFile: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--remove-hook-file") args.removeHookFile = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function isAdvisorHookCommand(hook) {
  return hook
    && hook.type === "command"
    && typeof hook.command === "string"
    && hook.command.includes("native-agent-pool-advisor.mjs");
}

function removeCommand(config) {
  let removed = 0;
  config.hooks ??= {};
  for (const eventName of EVENTS) {
    const entries = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
    const nextEntries = [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const nextHooks = hooks.filter((hook) => {
        const match = isAdvisorHookCommand(hook);
        if (match) removed += 1;
        return !match;
      });
      if (nextHooks.length > 0) nextEntries.push({ ...entry, hooks: nextHooks });
    }
    if (nextEntries.length > 0) config.hooks[eventName] = nextEntries;
    else delete config.hooks[eventName];
  }
  return removed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: uninstall.mjs [--dry-run] [--remove-hook-file]\n");
    return;
  }

  const home = codexHome();
  const hooksPath = join(home, "hooks.json");
  const targetHook = join(home, "hooks", "native-agent-pool-advisor.mjs");
  const targetWatcher = watcherTarget(home);
  const manageLaunchd = shouldManageLaunchd(home);
  const plist = manageLaunchd ? launchAgentPath() : "";
  const config = await readJsonOrDefault(hooksPath, { hooks: {} });
  const removed = removeCommand(config);
  const hookFileExists = await pathExists(targetHook);
  const watcherFileExists = await pathExists(targetWatcher);
  const plistExists = plist ? await pathExists(plist) : false;

  if (!args.dryRun) {
    if (manageLaunchd) {
      await runLaunchctl(["bootout", `gui/${process.getuid?.() ?? ""}/${WATCHER_LABEL}`]);
    }
    if (await pathExists(hooksPath)) {
      const backupPath = `${hooksPath}.backup-native-agent-pool-advisor-uninstall-${new Date().toISOString().replace(/[-:.]/g, "")}`;
      await copyFile(hooksPath, backupPath);
    }
    await writeJsonAtomic(hooksPath, config);
    if (args.removeHookFile) await rm(targetHook, { force: true });
    await rm(targetWatcher, { force: true });
    if (plist) await rm(plist, { force: true });
  }

  process.stdout.write(`${JSON.stringify({
    dry_run: args.dryRun,
    removed_registrations: removed,
    hook_file_exists: hookFileExists,
    hook_file_removed: !args.dryRun && args.removeHookFile && hookFileExists,
    watcher_file_exists: watcherFileExists,
    watcher_file_removed: !args.dryRun && watcherFileExists,
    launch_agent_exists: plistExists,
    launch_agent_removed: !args.dryRun && plistExists,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

function removeCommand(config, command) {
  let removed = 0;
  config.hooks ??= {};
  for (const eventName of EVENTS) {
    const entries = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
    const nextEntries = [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const nextHooks = hooks.filter((hook) => {
        const match = hook?.type === "command" && hook.command === command;
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
  const config = await readJsonOrDefault(hooksPath, { hooks: {} });
  const command = hookCommand(home);
  const removed = removeCommand(config, command);
  const hookFileExists = await pathExists(targetHook);

  if (!args.dryRun) {
    if (await pathExists(hooksPath)) {
      const backupPath = `${hooksPath}.backup-native-agent-pool-advisor-uninstall-${new Date().toISOString().replace(/[-:.]/g, "")}`;
      await copyFile(hooksPath, backupPath);
    }
    await writeJsonAtomic(hooksPath, config);
    if (args.removeHookFile) await rm(targetHook, { force: true });
  }

  process.stdout.write(`${JSON.stringify({
    dry_run: args.dryRun,
    removed_registrations: removed,
    hook_file_exists: hookFileExists,
    hook_file_removed: !args.dryRun && args.removeHookFile && hookFileExists,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

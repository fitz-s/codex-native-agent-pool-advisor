#!/usr/bin/env node

import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStop"];

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

function isAdvisorHookCommand(hook) {
  return hook && hook.type === "command" && typeof hook.command === "string" && hook.command.includes("native-agent-pool-advisor.mjs");
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write("usage: uninstall.mjs [--dry-run] [--remove-hook-file]\n");
    return;
  }
  for (const arg of args) if (arg !== "--dry-run" && arg !== "--remove-hook-file") throw new Error(`unknown argument: ${arg}`);
  const home = codexHome();
  const hooksPath = join(home, "hooks.json");
  const hookPath = join(home, "hooks", "native-agent-pool-advisor.mjs");
  let config = { hooks: {} };
  if (await pathExists(hooksPath)) config = JSON.parse(await readFile(hooksPath, "utf-8"));
  let removed = 0;
  for (const eventName of EVENTS) {
    const entries = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
    const remaining = [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const filtered = hooks.filter((hook) => {
        if (isAdvisorHookCommand(hook)) {
          removed += 1;
          return false;
        }
        return true;
      });
      if (filtered.length > 0) remaining.push({ ...entry, hooks: filtered });
    }
    if (remaining.length > 0) config.hooks[eventName] = remaining;
    else delete config.hooks[eventName];
  }
  const dryRun = args.has("--dry-run");
  const removeHook = args.has("--remove-hook-file");
  if (!dryRun) {
    await writeJsonAtomic(hooksPath, config);
    if (removeHook) await rm(hookPath, { force: true });
  }
  process.stdout.write(`${JSON.stringify({ dry_run: dryRun, removed_registrations: removed, hook_file_removed: !dryRun && removeHook }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

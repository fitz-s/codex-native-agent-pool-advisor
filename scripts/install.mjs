#!/usr/bin/env node

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHook = join(repoRoot, "hooks", "native-agent-pool-advisor.mjs");

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

function commandMatches(hook, command) {
  return hook && hook.type === "command" && hook.command === command;
}

function hookEntryMatcher(eventName) {
  return eventName === "SessionStart" ? "startup|resume" : "";
}

function entryMatcher(entry) {
  return typeof entry?.matcher === "string" ? entry.matcher : "";
}

function ensureHook(config, eventName, command) {
  config.hooks ??= {};
  const entries = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
  const requiredMatcher = hookEntryMatcher(eventName);
  let changed = false;
  let present = false;
  const nextEntries = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    const hasCorrectRegistration = entryMatcher(entry) === requiredMatcher
      && hooks.some((hook) => commandMatches(hook, command));
    if (hasCorrectRegistration) {
      present = true;
      nextEntries.push(entry);
      continue;
    }
    const nextHooks = hooks.filter((hook) => !commandMatches(hook, command));
    if (nextHooks.length !== hooks.length) changed = true;
    if (nextHooks.length > 0) nextEntries.push({ ...entry, hooks: nextHooks });
  }
  if (present) {
    config.hooks[eventName] = nextEntries;
    return changed;
  }
  config.hooks[eventName] = [
    {
      ...(requiredMatcher ? { matcher: requiredMatcher } : {}),
      hooks: [{ type: "command", command }],
    },
    ...nextEntries,
  ];
  return true;
}

async function main() {
  const home = codexHome();
  const targetHook = join(home, "hooks", "native-agent-pool-advisor.mjs");
  await mkdir(dirname(targetHook), { recursive: true });
  await copyFile(sourceHook, targetHook);

  const hooksPath = join(home, "hooks.json");
  const config = await readJsonOrDefault(hooksPath, { hooks: {} });
  const command = hookCommand(home);
  let changed = false;
  for (const eventName of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    changed = ensureHook(config, eventName, command) || changed;
  }
  if (changed || !(await pathExists(hooksPath))) await writeJsonAtomic(hooksPath, config);

  process.stdout.write(`installed ${targetHook}\n`);
  process.stdout.write(`registered ${command}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

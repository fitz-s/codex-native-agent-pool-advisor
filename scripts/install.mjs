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

function ensureHook(config, eventName, command) {
  config.hooks ??= {};
  const entries = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
  const present = entries.some((entry) => {
    return Array.isArray(entry?.hooks) && entry.hooks.some((hook) => commandMatches(hook, command));
  });
  if (present) {
    config.hooks[eventName] = entries;
    return false;
  }
  config.hooks[eventName] = [{ hooks: [{ type: "command", command }] }, ...entries];
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
  for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
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

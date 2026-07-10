#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHook = join(repoRoot, "hooks", "native-agent-pool-advisor.mjs");
const ACTIVE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostCompact", "SubagentStop"];
const RETIRED_EVENTS = ["PostToolUse", "PreCompact"];
const WATCHER_LABEL = "com.fitz.codex-native-agent-pool-global-state-watch";
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

function defaultCodexHome() {
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, ".codex") : "";
}

function hookCommand(home) {
  return `"${process.execPath}" "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"`;
}

function watcherPath(home) {
  return join(home, "hooks", "native-agent-pool-global-state-watch.mjs");
}

function watcherPlistPath() {
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return home ? join(home, "Library", "LaunchAgents", `${WATCHER_LABEL}.plist`) : "";
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
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function isAdvisorHookCommand(hook) {
  return hook && hook.type === "command" && typeof hook.command === "string" && hook.command.includes("native-agent-pool-advisor.mjs");
}

function isLegacyOrchestrationHook(hook) {
  return hook && hook.type === "command" && typeof hook.command === "string"
    && LEGACY_HOOK_COMMANDS.some((pattern) => pattern.test(hook.command));
}

function removeLegacyOrchestrationHooks(config) {
  config.hooks ??= {};
  const removed = [];
  for (const [eventName, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    const remaining = [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const kept = hooks.filter((hook) => {
        if (!isLegacyOrchestrationHook(hook)) return true;
        removed.push({ event: eventName, command: hook.command });
        return false;
      });
      if (kept.length > 0) remaining.push({ ...entry, hooks: kept });
    }
    if (remaining.length > 0) config.hooks[eventName] = remaining;
    else delete config.hooks[eventName];
  }
  return removed;
}

function matcherFor(eventName) {
  return eventName === "SessionStart" ? "startup|resume|clear" : "";
}

function ensureHook(config, eventName, command) {
  config.hooks ??= {};
  const matcher = matcherFor(eventName);
  const entries = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
  const remaining = [];
  let inserted = false;
  let changed = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      remaining.push(entry);
      continue;
    }
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    const withoutAdvisor = hooks.filter((hook) => !isAdvisorHookCommand(hook));
    changed ||= withoutAdvisor.length !== hooks.length;
    if (!inserted && safeString(entry.matcher) === matcher) {
      remaining.push({ ...entry, hooks: [...withoutAdvisor, { type: "command", command }] });
      inserted = true;
      changed = true;
    } else if (withoutAdvisor.length > 0) {
      remaining.push({ ...entry, hooks: withoutAdvisor });
    }
  }
  if (!inserted) {
    remaining.unshift({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
    changed = true;
  }
  config.hooks[eventName] = remaining;
  return changed;
}

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function removeAdvisorHooks(config, eventName) {
  const entries = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
  let changed = false;
  const remaining = [];
  for (const entry of entries) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    const withoutAdvisor = hooks.filter((hook) => !isAdvisorHookCommand(hook));
    changed ||= withoutAdvisor.length !== hooks.length;
    if (withoutAdvisor.length > 0) remaining.push({ ...entry, hooks: withoutAdvisor });
  }
  if (remaining.length > 0) config.hooks[eventName] = remaining;
  else delete config.hooks[eventName];
  return changed;
}

async function retireLegacyWatcher(home) {
  const retired = [];
  let bootout = "not_applicable";
  if (process.platform === "darwin" && home === defaultCodexHome()) {
    try {
      await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${WATCHER_LABEL}`], { timeout: 5000, maxBuffer: 1024 * 1024 });
      bootout = "stopped";
    } catch {
      bootout = "not_running";
    }
  }
  const paths = [watcherPath(home)];
  if (home === defaultCodexHome()) paths.push(watcherPlistPath());
  for (const path of paths.filter(Boolean)) {
    if (!(await pathExists(path))) continue;
    const disabled = `${path}.disabled-${new Date().toISOString().replace(/[-:.]/g, "")}`;
    await rename(path, disabled);
    retired.push(disabled);
  }
  return { bootout, retired };
}

async function retireLegacySelfHeal(home) {
  const path = join(home, "hooks", "quiet-omx-status-self-heal.mjs");
  if (!(await pathExists(path))) return null;
  const disabled = `${path}.disabled-${new Date().toISOString().replace(/[-:.]/g, "")}`;
  await rename(path, disabled);
  return disabled;
}

async function main() {
  const home = codexHome();
  const targetHook = join(home, "hooks", "native-agent-pool-advisor.mjs");
  await mkdir(dirname(targetHook), { recursive: true });
  await copyFile(sourceHook, targetHook);
  const watcher = await retireLegacyWatcher(home);
  const selfHeal = await retireLegacySelfHeal(home);
  const hooksPath = join(home, "hooks.json");
  const config = await readJsonOrDefault(hooksPath, { hooks: {} });
  const command = hookCommand(home);
  const removedLegacyHooks = removeLegacyOrchestrationHooks(config);
  let changed = removedLegacyHooks.length > 0;
  for (const eventName of ACTIVE_EVENTS) changed = ensureHook(config, eventName, command) || changed;
  for (const eventName of RETIRED_EVENTS) changed = removeAdvisorHooks(config, eventName) || changed;
  if (changed || !(await pathExists(hooksPath))) await writeJsonAtomic(hooksPath, config);
  process.stdout.write(`${JSON.stringify({ installed: targetHook, active_events: ACTIVE_EVENTS, retired_legacy_watcher: watcher, retired_legacy_self_heal: selfHeal, removed_legacy_hooks: removedLegacyHooks }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

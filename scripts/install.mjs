#!/usr/bin/env node

import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHook = join(repoRoot, "hooks", "native-agent-pool-advisor.mjs");
const sourceWatcher = join(repoRoot, "scripts", "global-state-watch.mjs");
const WATCHER_LABEL = "com.fitz.codex-native-agent-pool-global-state-watch";

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

function hookCommand(home) {
  return `"${process.execPath}" "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"`;
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

function shouldManageLaunchd(home) {
  if (process.env.NATIVE_AGENT_POOL_SKIP_WATCHER === "1") return false;
  if (process.env.NATIVE_AGENT_POOL_INSTALL_WATCHER === "1") return process.platform === "darwin";
  return process.platform === "darwin" && home === defaultCodexHome();
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function watcherPlist(home) {
  const watcher = watcherTarget(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(watcher)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_HOME</key>
    <string>${xmlEscape(home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(home, "log", "native-agent-pool-global-state-watch.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(home, "log", "native-agent-pool-global-state-watch.stderr.log"))}</string>
</dict>
</plist>
`;
}

async function runLaunchctl(args) {
  try {
    await execFileAsync("launchctl", args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function launchdServiceRunning(serviceTarget) {
  return runLaunchctl(["print", serviceTarget]);
}

async function installWatcher(home) {
  const target = watcherTarget(home);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(sourceWatcher, target);
  const plist = launchAgentPath();
  if (!plist || !shouldManageLaunchd(home)) {
    return { copied: true, launchd: "skipped" };
  }
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(plist, watcherPlist(home));
  const domain = `gui/${process.getuid?.() ?? ""}`;
  const serviceTarget = `${domain}/${WATCHER_LABEL}`;
  await runLaunchctl(["bootout", serviceTarget]);
  await runLaunchctl(["bootstrap", domain, plist]);
  await runLaunchctl(["kickstart", "-k", serviceTarget]);
  if (!(await launchdServiceRunning(serviceTarget))) {
    // launchd may still be tearing down the old job after bootout; one retry
    // makes install idempotent without treating a successful daemon as failed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runLaunchctl(["bootstrap", domain, plist]);
    await runLaunchctl(["kickstart", "-k", serviceTarget]);
  }
  return { copied: true, launchd: await launchdServiceRunning(serviceTarget) ? "started" : "start_failed", plist };
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

function isAdvisorHookCommand(hook) {
  return hook
    && hook.type === "command"
    && typeof hook.command === "string"
    && hook.command.includes("native-agent-pool-advisor.mjs");
}

function hookEntryMatcher(eventName) {
  return eventName === "SessionStart" ? "startup|resume|clear" : "";
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
    const nextHooks = hooks.filter((hook) => !isAdvisorHookCommand(hook));
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
  const watcher = await installWatcher(home);

  const hooksPath = join(home, "hooks.json");
  const config = await readJsonOrDefault(hooksPath, { hooks: {} });
  const command = hookCommand(home);
  let changed = false;
  for (const eventName of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact"]) {
    changed = ensureHook(config, eventName, command) || changed;
  }
  if (changed || !(await pathExists(hooksPath))) await writeJsonAtomic(hooksPath, config);

  process.stdout.write(`installed ${targetHook}\n`);
  process.stdout.write(`registered ${command}\n`);
  process.stdout.write(`watcher ${JSON.stringify(watcher)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

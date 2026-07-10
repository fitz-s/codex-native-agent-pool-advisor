#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const WATCH_INTERVAL_MS = 500;
const DEBOUNCE_MS = 800;
const RETRY_MS = 2000;
const HOOK_TIMEOUT_MS = 15000;

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function codexHome() {
  const explicit = safeString(process.env.CODEX_HOME).trim();
  if (explicit) return explicit;
  const home = safeString(process.env.HOME).trim();
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

function hookPath(home) {
  return join(home, "hooks", "native-agent-pool-advisor.mjs");
}

function globalStatePath(home) {
  return join(home, ".codex-global-state.json");
}

function logPath(home) {
  return join(home, "log", "native-agent-pool-global-state-watch.log");
}

async function appendLog(home, record) {
  try {
    const path = logPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
      flag: "a",
    });
  } catch {
    // Watcher logging must not keep the process from sanitizing state.
  }
}

function runHookWithInput(command, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeout);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`hook exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function sanitize(home, reason) {
  const hook = hookPath(home);
  if (!existsSync(hook)) {
    await appendLog(home, { event: "hook_missing", hook });
    return;
  }
  const payload = {
    hook_event_name: "PreToolUse",
    thread_id: "native-agent-pool-global-state-watch",
    cwd: safeString(process.env.PWD) || home,
    tool_name: "shell",
    tool_input: {},
    watcher_reason: reason,
  };
  try {
    await runHookWithInput(process.execPath, [hook], JSON.stringify(payload), {
      timeout: HOOK_TIMEOUT_MS,
      env: {
        ...process.env,
        CODEX_HOME: home,
        NATIVE_AGENT_POOL_GLOBAL_STATE_WATCHER: "1",
      },
    });
    await appendLog(home, { event: "sanitize_ok", reason });
  } catch (error) {
    await appendLog(home, {
      event: "sanitize_failed",
      reason,
      message: error instanceof Error ? error.message : String(error),
      stdout: safeString(error?.stdout).slice(0, 1000),
      stderr: safeString(error?.stderr).slice(0, 1000),
    });
    throw error;
  }
}

async function main() {
  const home = codexHome();
  const target = globalStatePath(home);
  let running = false;
  let pending = false;
  let timer = null;
  let lastMtimeMs = 0;
  let lastSize = 0;

  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        await sanitize(home, reason);
      } catch {
        setTimeout(() => schedule("retry_after_failure"), RETRY_MS);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          schedule("pending_change");
        }
      }
    }, DEBOUNCE_MS);
  };

  await appendLog(home, { event: "watch_start", target });
  await sanitize(home, "startup").catch(() => {
    setTimeout(() => schedule("retry_after_startup_failure"), RETRY_MS);
  });
  setInterval(async () => {
    try {
      const stats = await stat(target);
      if (stats.mtimeMs === lastMtimeMs && stats.size === lastSize) return;
      lastMtimeMs = stats.mtimeMs;
      lastSize = stats.size;
      schedule("global_state_changed");
    } catch {
      // The file can be briefly absent during app startup or atomic rewrites.
    }
  }, WATCH_INTERVAL_MS);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

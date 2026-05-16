import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(repoRoot, "hooks", "native-agent-pool-advisor.mjs");

async function withHome(work) {
  const home = await mkdtemp(join(tmpdir(), "native-agent-pool-advisor-test-"));
  try {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(join(home, "config.toml"), "[agents]\nmax_threads = 6\n");
    return await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function sqlite(home, sql, args = []) {
  return execFileAsync("sqlite3", [join(home, "state_5.sqlite"), sql, ...args], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function sqliteReadonly(home, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", join(home, "state_5.sqlite"), sql], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function createNativeTables(home) {
  await sqlite(
    home,
    [
      "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
      "create table threads(id text, rollout_path text, title text, agent_role text, model text, reasoning_effort text, agent_nickname text, cwd text, updated_at integer);",
    ].join(" "),
  );
}

async function runHook(home, payload) {
  const child = spawn(process.execPath, [hookPath], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hook timed out"));
    }, 5000);
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0, stderr);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

test("blocks wrapped spawn_agent when native edge cap is full", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open'),('parent1','a6','open');",
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "multi_tool_use.parallel",
      session_id: "parent1",
      tool_input: {
        tool_uses: [
          {
            recipient_name: "functions.spawn_agent",
            parameters: {
              agent_type: "explorer",
              model: "gpt-5.3-codex-spark",
              reasoning_effort: "low",
              message: "map files",
            },
          },
        ],
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /6\/6/);
  });
});

test("blocks wrapped explorer spawn that would inherit the frontier model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "multi_tool_use.parallel",
      session_id: "parent1",
      tool_input: {
        tool_uses: [
          {
            recipient_name: "functions.spawn_agent",
            parameters: { agent_type: "explorer", message: "grep task" },
          },
        ],
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /gpt-5\.3-codex-spark/);
  });
});

test("empty native table falls back to transcripts unless an explicit reset marker cuts off old events", async () => {
  await withHome(async (home) => {
    const sessionDir = join(home, "sessions", "2026", "05", "16");
    await mkdir(sessionDir, { recursive: true });
    const transcript = join(sessionDir, "parent.jsonl");
    await writeFile(
      transcript,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}',
        '{"timestamp":"2026-05-16T08:00:01.000Z","type":"event_msg","payload":{"type":"collab_agent_spawn_end","sender_thread_id":"parent1","new_thread_id":"child1"}}',
      ].join("\n"),
    );

    const beforeReset = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn agent status",
    });
    assert.match(beforeReset.hookSpecificOutput.additionalContext, /occupied=1\/6/);

    await writeFile(
      join(home, "state", "native-agent-pool-advisor.json"),
      JSON.stringify({
        version: 1,
        updated_at: "2026-05-16T08:10:00.000Z",
        last_native_pool_reset_at: "2026-05-16T08:09:47.000Z",
        native_pool_reset_threads: {},
        native_pool_pruned_parent_at: {},
        sessions: {},
      }),
    );
    const afterReset = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn agent status again",
    });
    assert.match(afterReset.hookSpecificOutput.additionalContext, /occupied=0\/6/);
  });
});

test("successful close_agent is the only automatic native edge release", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "child1" },
      tool_response: { status: "closed" },
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "closed|1");
  });
});

test("reset script backs up DB, clears selected parent, and writes reset marker", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent2','child2','open');",
    );

    const { stdout } = await execFileAsync(process.execPath, [join(repoRoot, "scripts", "reset-pool.mjs"), "--parent", "parent1"], {
      env: { ...process.env, CODEX_HOME: home },
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.parent, "parent1");
    assert.equal(result.changed, 1);
    assert.equal(await sqliteReadonly(home, "select parent_thread_id,status,count(*) from thread_spawn_edges group by parent_thread_id,status order by parent_thread_id;"), "parent2|open|1");

    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    assert.equal(state.native_pool_reset_threads.parent1, result.reset_at);
  });
});

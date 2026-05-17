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
const installPath = join(repoRoot, "scripts", "install.mjs");
const resetPath = join(repoRoot, "scripts", "reset-pool.mjs");
const doctorPath = join(repoRoot, "scripts", "doctor.mjs");
const uninstallPath = join(repoRoot, "scripts", "uninstall.mjs");

async function withHome(work, configText = "[agents]\nmax_threads = 6\n") {
  const home = await mkdtemp(join(tmpdir(), "native-agent-pool-advisor-test-"));
  try {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(join(home, "config.toml"), configText);
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

async function writeTaskCompleteTranscript(home, id) {
  const path = join(home, `${id}.jsonl`);
  await writeFile(
    path,
    [
      `{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"${id}"}}`,
      '{"timestamp":"2026-05-16T08:00:02.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
    ].join("\n"),
  );
  return path;
}

async function writeFalseTaskCompleteTranscript(home, id) {
  const path = join(home, `${id}.jsonl`);
  await writeFile(
    path,
    [
      `{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"${id}"}}`,
      '{"timestamp":"2026-05-16T08:00:02.000Z","type":"response_item","payload":{"type":"message","text":"quoted string: \\"task_complete\\""}}',
    ].join("\n"),
  );
  return path;
}

async function runScript(scriptPath, home, args = [], envOverrides = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, CODEX_HOME: home, ...envOverrides },
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function runHook(home, payload, envOverrides = {}) {
  const child = spawn(process.execPath, [hookPath], {
    env: { ...process.env, CODEX_HOME: home, ...envOverrides },
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
    }, 8000);
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
    assert.match(output.reason, /gpt-5\.4-mini/);
  });
});

test("allows mini fallback model for explorer spawns by default", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.4-mini",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.notEqual(output?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:parent1"].spawn_reservations);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].count, 1);
  });
});

test("advises on broad spark explorer prompts without blocking the spawn", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: [
          "Read-only investigation in /repo.",
          "Task: analyze whether submitted live order prices were mathematically/strategically correct or too far below ask to ever fill.",
          "Trace posterior -> snapshot VWMP/best ask -> compute_native_limit_price -> passive/marketable branch -> Kelly sizing and discounts/fallbacks.",
          "Inspect src/engine/cycle_runtime.py, src/contracts/semantic_types.py, src/contracts/execution_intent.py, src/engine/evaluator.py, settings, and tests.",
          "Return whether this is intended post_only maker behavior, a limit price math bug, a Kelly/discount fallback, or an execution-policy mismatch.",
        ].join(" "),
      },
    });

    assert.notEqual(output?.decision, "block");
    assert.match(output.hookSpecificOutput.additionalContext, /Explorer route advisory, not a block/);
    assert.match(output.hookSpecificOutput.additionalContext, /scout\/anchor collection/);
    assert.match(output.hookSpecificOutput.additionalContext, /gpt-5\.4-mini/);
  });
});

test("advises on non-low reasoning spark explorer route without blocking", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "medium",
        message: "Find all references to compute_native_limit_price.",
      },
    });

    assert.notEqual(output?.decision, "block");
    assert.match(output.hookSpecificOutput.additionalContext, /Explorer route advisory, not a block/);
    assert.match(output.hookSpecificOutput.additionalContext, /output contract is scout\/anchor collection/);
    assert.match(output.hookSpecificOutput.additionalContext, /gpt-5\.4-mini/);
  });
});

test("advises when mini is used for disposable narrow scans but still allows it", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.4-mini",
        reasoning_effort: "low",
        message: "Find all references to compute_native_limit_price.",
      },
    });

    assert.notEqual(output?.decision, "block");
    assert.match(output.hookSpecificOutput.additionalContext, /narrow scan/);
    assert.match(output.hookSpecificOutput.additionalContext, /gpt-5\.3-codex-spark/);
  });
});

test("explorer model allow-list can be customized by advisor config", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await writeFile(
      join(home, "native-agent-pool-advisor.config.json"),
      JSON.stringify({
        models: {
          explorer: ["local-scan", "local-mini"],
        },
      }),
    );

    const allowed = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "local-mini",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.notEqual(allowed?.decision, "block");

    const blocked = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent2",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason, /local-scan, local-mini/);
  });
});

test("blocks wrapped multi-spawn when requested spawn count exceeds remaining capacity", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open');",
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
          {
            recipient_name: "functions.spawn_agent",
            parameters: {
              agent_type: "explorer",
              model: "gpt-5.3-codex-spark",
              reasoning_effort: "low",
              message: "map tests",
            },
          },
        ],
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /requested_spawns=2/);
  });
});

test("native open edges with task_complete transcripts still occupy capacity until closed", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `child${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','done ${id}','explorer','gpt-5.3-codex-spark','low','Agent ${index}','/tmp',1778920000);`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const promptOutput = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "spawn agent status",
    });
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /occupied=6\/6/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /native_current=open=0, terminal_open=6/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /Only a successful close_agent result decrements/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /remaining_spawn_budget=0/);

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.equal(spawnOutput.decision, "block");
    assert.match(spawnOutput.reason, /6\/6/);
    assert.match(spawnOutput.reason, /terminal_open=6/);
  });
});

test("overfull native open-edge evidence saturates occupied at the runtime cap", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 8; index += 1) {
      const id = `child${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','done ${id}','explorer','gpt-5.3-codex-spark','low','Agent ${index}','/tmp',177892000${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const promptOutput = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "spawn agent status",
    });
    const context = promptOutput.hookSpecificOutput.additionalContext;
    assert.match(context, /occupied=6\/6/);
    assert.doesNotMatch(context, /occupied=8\/6/);
    assert.match(context, /unresolved_open_edges=8/);
    assert.match(context, /open_edge_overflow=2/);

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.equal(spawnOutput.decision, "block");
    assert.match(spawnOutput.reason, /6\/6/);
    assert.match(spawnOutput.reason, /open_edge_overflow=2/);
  });
});

test("successful close after a cap hit can free one runtime slot despite stale open-edge overflow", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 8; index += 1) {
      const id = `child${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','done ${id}','explorer','gpt-5.3-codex-spark','low','Agent ${index}','/tmp',177892000${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const transcript = join(home, "parent.jsonl");
    await writeFile(
      transcript,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}',
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"explorer\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn1","output":"collab spawn failed: agent thread limit reached"}}',
        '{"timestamp":"2026-05-16T08:01:02.000Z","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close1","arguments":"{\\"target\\":\\"child8\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"{\\"status\\":\\"closed\\"}"}}',
      ].join("\n"),
    );

    const promptOutput = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn agent status",
    });
    const context = promptOutput.hookSpecificOutput.additionalContext;
    assert.match(context, /occupied=5\/6/);
    assert.match(context, /remaining_spawn_budget=1/);
    assert.match(context, /slot_pressure_source=transcript_events/);
    assert.match(context, /unresolved_open_edges=8/);

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.notEqual(spawnOutput?.decision, "block");
  });
});

test("failed close after a cap hit does not free runtime capacity", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open'),('parent1','child4','open'),('parent1','child5','open'),('parent1','child6','open');",
    );

    const transcript = join(home, "parent.jsonl");
    await writeFile(
      transcript,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}',
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"explorer\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn1","output":"collab spawn failed: agent thread limit reached"}}',
        '{"timestamp":"2026-05-16T08:01:02.000Z","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close1","arguments":"{\\"target\\":\\"child6\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"failed to close: unknown agent"}}',
      ].join("\n"),
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /6\/6/);
    assert.match(output.reason, /failed_closes=1/);
  });
});

test("task_complete text in non-event transcript records does not mark native edge stale", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `child${index}`;
      const path = await writeFalseTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','live ${id}','explorer','gpt-5.3-codex-spark','low','Agent ${index}','/tmp',1778920000);`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /native_current=open=6, terminal_open=0/);
  });
});

test("native authoritative state is not vetoed by stale transcript fallback count", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");
    const transcript = join(home, "parent.jsonl");
    const lines = ['{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}'];
    for (let index = 1; index <= 6; index += 1) {
      lines.push(`{"timestamp":"2026-05-16T08:00:0${index}.000Z","type":"event_msg","payload":{"type":"collab_agent_spawn_end","sender_thread_id":"parent1","new_thread_id":"stale${index}"}}`);
    }
    await writeFile(transcript, lines.join("\n"));

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.notEqual(output?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:parent1"].spawn_reservations);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].count, 1);
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

test("fresh lock contention blocks spawn conservatively", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "state", "native-agent-pool-advisor.lock"), { recursive: true });
    await writeFile(join(home, "state", "native-agent-pool-advisor.lock", "owner"), "test lock\n");
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /state lock is unavailable/);
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

test("wrapped close_agent post-tool evidence repairs native edge state", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "multi_tool_use.parallel",
      session_id: "parent1",
      tool_input: {
        tool_uses: [
          {
            recipient_name: "functions.close_agent",
            parameters: { target: "child1" },
          },
        ],
      },
      tool_response: [{ recipient_name: "functions.close_agent", output: { status: "closed" } }],
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "closed|1");
  });
});

test("max_threads is read from the agents TOML section only", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open');",
    );
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /4\/4/);
  }, "[unrelated]\nmax_threads = 99\n\n[agents]\nmax_threads = 4\n");
});

test("installer is idempotent for existing hooks.json", async () => {
  await withHome(async (home) => {
    await runScript(installPath, home);
    await runScript(installPath, home);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      const count = config.hooks[eventName]
        .flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.command.includes("native-agent-pool-advisor.mjs")).length;
      assert.equal(count, 1, eventName);
    }
  });
});

test("doctor validates install and uninstall removes advisor registrations", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await runScript(installPath, home);
    const doctor = JSON.parse((await runScript(doctorPath, home)).stdout);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.checks.registrations.UserPromptSubmit, 1);

    const dryRun = JSON.parse((await runScript(uninstallPath, home, ["--dry-run"])).stdout);
    assert.equal(dryRun.removed_registrations, 3);

    const removed = JSON.parse((await runScript(uninstallPath, home)).stdout);
    assert.equal(removed.removed_registrations, 3);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      const entries = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
      const count = entries
        .flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.command.includes("native-agent-pool-advisor.mjs")).length;
      assert.equal(count, 0, eventName);
    }
  });
});

test("reset script requires dry-run force token before mutation", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent2','child2','open');",
    );

    await assert.rejects(
      runScript(resetPath, home, ["--parent", "parent1"]),
      /requires --force/,
    );

    const dryRun = await runScript(resetPath, home, ["--parent", "parent1", "--dry-run"]);
    const dryRunResult = JSON.parse(dryRun.stdout);
    assert.equal(dryRunResult.dry_run, true);
    assert.ok(dryRunResult.force_token);

    const { stdout } = await runScript(resetPath, home, [
      "--parent",
      "parent1",
      "--force",
      dryRunResult.force_token,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.parent, "parent1");
    assert.equal(result.changed, 1);
    assert.equal(await sqliteReadonly(home, "select parent_thread_id,status,count(*) from thread_spawn_edges group by parent_thread_id,status order by parent_thread_id;"), "parent2|open|1");

    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    assert.equal(state.native_pool_reset_threads.parent1, result.reset_at);
  });
});

test("global reset requires explicit global confirmation and force token", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open'),('parent2','child2','open');");

    const dryRun = await runScript(resetPath, home, ["--global", "--dry-run"]);
    const dryRunResult = JSON.parse(dryRun.stdout);
    assert.equal(dryRunResult.scope, "global");
    await assert.rejects(
      runScript(resetPath, home, ["--global", "--force", dryRunResult.force_token]),
      /requires --confirm-global-reset/,
    );

    const { stdout } = await runScript(resetPath, home, [
      "--global",
      "--confirm-global-reset",
      "--force",
      dryRunResult.force_token,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.parent, null);
    assert.equal(result.changed, 2);
    assert.equal(await sqliteReadonly(home, "select count(*) from thread_spawn_edges;"), "0");
  });
});

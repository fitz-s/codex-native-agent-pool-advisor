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
const liveCheckPath = join(repoRoot, "scripts", "live-check.mjs");
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

async function writeEarlyTaskCompleteLongTranscript(home, id) {
  const path = join(home, `${id}-long.jsonl`);
  await writeFile(
    path,
    [
      `{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"${id}"}}`,
      '{"timestamp":"2026-05-16T08:00:02.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
      "x".repeat((2 * 1024 * 1024) + 4096),
    ].join("\n"),
  );
  return path;
}

async function writeChildSessionTranscript(home, dateParts, parentId, id) {
  const path = join(home, "sessions", ...dateParts, `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      JSON.stringify({
        timestamp: "2026-05-16T08:00:00.000Z",
        type: "session_meta",
        payload: {
          id,
          source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
        },
      }),
      '{"timestamp":"2026-05-16T08:00:02.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
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

test("missing native edge database blocks spawn conservatively", async () => {
  await withHome(async (home) => {
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
    assert.match(output.reason, /Native thread_spawn_edges could not be read/);
    assert.match(output.reason, /native_slots=unavailable/);
  });
});

test("unscoped spawn hook payload blocks instead of merging cwd state", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /unscoped payload must not fall back to a shared cwd bucket/);
  });
});

test("unrelated parent native open edges do not block current parent", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('full-parent','g1','open'),('full-parent','g2','open'),('full-parent','g3','open'),('full-parent','g4','open'),('full-parent','g5','open'),('full-parent','g6','open');",
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "empty-parent",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.notEqual(output?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:empty-parent"].spawn_reservations);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].count, 1);
  });
});

test("unrelated parent native open edges do not emit zero budget on current prompt", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('full-parent','g1','open'),('full-parent','g2','open'),('full-parent','g3','open'),('full-parent','g4','open'),('full-parent','g5','open'),('full-parent','g6','open');",
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "empty-parent",
      prompt: "Send messages to two existing agents, then try a new explorer.",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_LOCAL_COUNTER_START=6/);
    assert.match(context, /native_slots=slot_open=0/);
    assert.doesNotMatch(context, /native_global/);
    assert.doesNotMatch(context, /Global native/);
  });
});

test("blocks wrapped spawn that would inherit the parent frontier model", async () => {
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
    assert.match(output.reason, /explicit model/);
    assert.match(output.reason, /Default to gpt-5\.4-mini/);
    assert.match(output.reason, /gpt-5\.3-codex-spark/);
    assert.match(output.reason, /gpt-5\.4-mini/);
  });
});

test("blocks non-explorer spawns that omit explicit model selection", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "worker",
        message: "Implement a bounded low-risk fix.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /explicit model/);
    assert.match(output.reason, /Default to gpt-5\.4-mini/);
    assert.match(output.reason, /model-selection judgment/);
  });
});

test("blocks fork_context spawn when it also specifies model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        fork_context: true,
        model: "gpt-5.4-mini",
        reasoning_effort: "medium",
        message: "Trace with full context.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /fork_context=true cannot be combined with an explicit model/);
    assert.match(output.reason, /tool-shape failure, not native-pool exhaustion/);
    assert.match(output.reason, /remove fork_context/);
    assert.match(output.reason, /do not treat this as a consumed native slot/);
  });
});

test("allows fork_context without model but warns about inherited model exception", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        fork_context: true,
        reasoning_effort: "medium",
        message: "Trace with exact full history.",
      },
    });

    assert.notEqual(output?.decision, "block");
    assert.match(output.hookSpecificOutput.additionalContext, /Fork-context model inheritance exception/);
    assert.match(output.hookSpecificOutput.additionalContext, /remove fork_context and pass compact context/);
  });
});

test("allows explicit frontier model for critic roles", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "critic",
        model: "gpt-5.5",
        reasoning_effort: "high",
        message: "Review architecture risk.",
      },
    });

    assert.notEqual(output?.decision, "block");
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

test("wrapped multi-spawn post responses are matched by same-tool ordinal", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await runHook(home, {
      hook_event_name: "PostToolUse",
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
      tool_response: [
        { recipient_name: "functions.spawn_agent", output: { agent_id: "child1" } },
        { recipient_name: "functions.spawn_agent", output: "collab spawn failed: agent thread limit reached" },
      ],
    });

    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const session = state.sessions["thread:parent1"];
    assert.equal(session.agents.child1.status, "running");
    assert.ok(session.last_cap_hit_at);

    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open'),('parent1','child4','open'),('parent1','child5','open'),('parent1','child6','open');",
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map more files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /cap_hit_after_last_close=yes/);
    assert.match(output.reason, /native_slots=slot_open=6/);
  });
});

test("wrapped multi-spawn post responses preserve distinct successful agent ids", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await runHook(home, {
      hook_event_name: "PostToolUse",
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
      tool_response: [
        { recipient_name: "functions.spawn_agent", output: { agent_id: "child1" } },
        { recipient_name: "functions.spawn_agent", output: { agent_id: "child2" } },
      ],
    });

    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const agents = state.sessions["thread:parent1"].agents;
    assert.equal(agents.child1.status, "running");
    assert.equal(agents.child2.status, "running");
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
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /native_slots=slot_open=0, slot_terminal=6/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /successful close_agent result or runtime not-found close evidence decrements/);
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
    assert.match(spawnOutput.reason, /slot_terminal=6/);
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
    assert.match(context, /slot_estimate=6\/6/);
    assert.match(context, /db_open_edge_debt=8/);
    assert.match(context, /open_edge_overflow=2/);
    assert.doesNotMatch(context, /terminal_open/);
    assert.doesNotMatch(context, /unresolved_open_edges/);

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
    assert.match(spawnOutput.reason, /slot_estimate=6\/6/);
    assert.match(spawnOutput.reason, /db_open_edge_debt=8/);
    assert.doesNotMatch(spawnOutput.reason, /terminal_open/);
    assert.doesNotMatch(spawnOutput.reason, /unresolved_open_edges/);
  });
});

test("transcript close after a cap hit does not override current-parent overfull native edges", async () => {
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
    assert.match(context, /occupied=6\/6/);
    assert.match(context, /remaining_spawn_budget=0/);
    assert.match(context, /slot_pressure_source=native_open_edges_saturated/);
    assert.match(context, /native_slots=slot_open=0, slot_terminal=6, slot_estimate=6\/6, db_open_edge_debt=8/);
    assert.doesNotMatch(context, /terminal_open=8/);
    assert.doesNotMatch(context, /native_global/);

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
    assert.equal(spawnOutput.decision, "block");
    assert.match(spawnOutput.reason, /native_slots=slot_open=0, slot_terminal=6, slot_estimate=6\/6, db_open_edge_debt=8/);
    assert.doesNotMatch(spawnOutput.reason, /terminal_open=8/);
    assert.doesNotMatch(spawnOutput.reason, /native_global/);
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
        '{"timestamp":"2026-05-16T08:01:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"failed to close: transport error"}}',
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

test("transcript close not found repairs stale open edge before next prompt", async () => {
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
        '{"timestamp":"2026-05-16T08:01:02.000Z","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close1","arguments":"{\\"target\\":\\"child6\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"agent with id child6 not found"}}',
      ].join("\n"),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn agent status",
    });

    assert.equal(
      await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status order by status;"),
      "closed|1\nopen|5",
    );
    assert.match(output.hookSpecificOutput.additionalContext, /occupied=5\/6/);
    assert.match(output.hookSpecificOutput.additionalContext, /remaining_spawn_budget=1/);
    assert.match(output.hookSpecificOutput.additionalContext, /native_slots=slot_open=5, slot_terminal=0/);
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
    assert.match(output.reason, /native_slots=slot_open=6, slot_terminal=0/);
  });
});

test("task_complete outside terminal tail still marks native edge terminal", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const path = await writeEarlyTaskCompleteLongTranscript(home, "child1");
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");
    await sqlite(
      home,
      `insert into threads values ('child1','${path}','done child1','explorer','gpt-5.3-codex-spark','low','Agent 1','/tmp',1778920000);`,
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "spawn agent status",
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /native_slots=slot_open=0, slot_terminal=1/);
    assert.match(context, /db_open_edge_debt=1/);
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

test("truncated transcript tail estimates do not undercut discovered child fallback", async () => {
  await withHome(async (home) => {
    const now = new Date();
    const dateParts = [
      String(now.getFullYear()).padStart(4, "0"),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ];
    for (let index = 1; index <= 6; index += 1) {
      await writeChildSessionTranscript(home, dateParts, "parent1", `child${index}`);
    }

    const transcript = join(home, "parent-tail.jsonl");
    await writeFile(
      transcript,
      [
        "truncated prefix from unread transcript head",
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn-tail","arguments":"{\\"agent_type\\":\\"explorer\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn-tail","output":"{\\"agent_id\\":\\"tail-child\\"}"}}',
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
    assert.match(output.reason, /transcript_slot=6/);
    assert.match(output.reason, /transcript_unresolved=7/);
    assert.doesNotMatch(output.reason, /transcript_slot=1/);
  });
});

test("truncated transcript tail close does not erase discovered child fallback", async () => {
  await withHome(async (home) => {
    const now = new Date();
    const dateParts = [
      String(now.getFullYear()).padStart(4, "0"),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ];
    for (let index = 1; index <= 6; index += 1) {
      await writeChildSessionTranscript(home, dateParts, "parent1", `child${index}`);
    }

    const transcript = join(home, "parent-close-tail.jsonl");
    await writeFile(
      transcript,
      [
        "truncated prefix from unread transcript head",
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-tail","arguments":"{\\"target\\":\\"not-a-discovered-child\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"close-tail","output":"{\\"status\\":\\"closed\\"}"}}',
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
    assert.match(output.reason, /transcript_slot=6/);
    assert.match(output.reason, /transcript_unresolved=6/);
    assert.doesNotMatch(output.reason, /transcript_slot=0/);
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

test("close_agent not found marks current-parent native edge unreachable", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "child1" },
      tool_response: "agent with id child1 not found",
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "closed|1");
  });
});

test("close_agent not found for non-owned target does not release current-parent capacity", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open'),('parent1','child4','open'),('parent1','child5','open'),('parent1','child6','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "typo-child" },
      tool_response: "agent with id typo-child not found",
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "open|6");
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
    assert.match(output.reason, /6\/6 estimated slots occupied/);
  });
});

test("close_agent not found repairs unique native edge even when hook session is mis-scoped", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open'),('parent1','child4','open'),('parent1','child5','open'),('parent1','child6','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "wrong-parent",
      tool_input: { target: "child6" },
      tool_response: "agent with id child6 not found",
    });

    assert.equal(
      await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status order by status;"),
      "closed|1\nopen|5",
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map one file",
      },
    });
    assert.notEqual(output?.decision, "block");
  });
});

test("close_agent not found does not repair ambiguous native child edge", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','shared-child','open'),('parent2','shared-child','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "wrong-parent",
      tool_input: { target: "shared-child" },
      tool_response: "agent with id shared-child not found",
    });

    assert.equal(
      await sqliteReadonly(
        home,
        "select parent_thread_id,status,count(*) from thread_spawn_edges group by parent_thread_id,status order by parent_thread_id;",
      ),
      "parent1|open|1\nparent2|open|1",
    );
  });
});

test("authoritative native open edges below cap override stale cap-hit state", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
      tool_response: "collab spawn failed: agent thread limit reached",
    });

    const promptOutput = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "open one more explorer",
    });
    const context = promptOutput.hookSpecificOutput.additionalContext;
    assert.match(context, /occupied=3\/6/);
    assert.match(context, /remaining_spawn_budget=3/);
    assert.match(context, /cap_hit_after_last_close=yes/);
    assert.match(context, /cap_hit_blocks_spawn=no/);
    assert.doesNotMatch(context, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map another file",
      },
    });
    assert.notEqual(spawnOutput?.decision, "block");
  });
});

test("runtime not-found close after cap hit releases current-parent native slot", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open'),('parent1','child4','open'),('parent1','child5','open'),('parent1','child6','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
      tool_response: "collab spawn failed: agent thread limit reached",
    });

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "child6" },
      tool_response: "agent with id child6 not found",
    });

    assert.equal(
      await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status order by status;"),
      "closed|1\nopen|5",
    );
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const session = state.sessions["thread:parent1"];
    assert.ok(Date.parse(session.last_close_at) > Date.parse(session.last_cap_hit_at));
    assert.equal(session.last_close_failed_at ?? "", "");

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map one more file",
      },
    });
    assert.notEqual(output?.decision, "block");
  });
});

test("wait_agent completion does not release a native edge slot", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open'),('parent1','child2','open'),('parent1','child3','open'),('parent1','child4','open'),('parent1','child5','open'),('parent1','child6','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "wait_agent",
      session_id: "parent1",
      tool_input: { targets: ["child1"] },
      tool_response: { completed: "done" },
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "open|6");

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
    assert.match(output.reason, /6\/6/);
    assert.match(output.reason, /native_slots=slot_open=6/);
  });
});

test("successful close_agent only repairs native edge for current parent", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('full-parent','global1','open'),('full-parent','global2','open'),('full-parent','global3','open'),('full-parent','global4','open'),('full-parent','global5','open'),('full-parent','global6','open');",
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "empty-parent",
      tool_input: { target: "global6" },
      tool_response: { status: "closed" },
    });

    assert.equal(
      await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status order by status;"),
      "open|6",
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "empty-parent",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.notEqual(output?.decision, "block");
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

test("session start emits cap pressure after resume before a spawn is attempted", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open'),('parent1','a6','open');",
    );

    const output = await runHook(home, {
      hook_event_name: "SessionStart",
      session_id: "parent1",
    });

    assert.match(output.hookSpecificOutput.additionalContext, /occupied=6\/6/);
    assert.match(output.hookSpecificOutput.additionalContext, /remaining_spawn_budget=0/);
    assert.match(output.hookSpecificOutput.additionalContext, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(output.hookSpecificOutput.additionalContext, /When remaining_spawn_budget is 0, do not call spawn_agent/);
    assert.match(output.hookSpecificOutput.additionalContext, /zero-budget snapshot/);
    assert.match(output.hookSpecificOutput.additionalContext, /ZERO_BUDGET_RECOVERY_REQUIRED=true/);
    assert.match(output.hookSpecificOutput.additionalContext, /Do not stop at saying the subagent pool is full/);
    assert.match(output.hookSpecificOutput.additionalContext, /choose one recovery action/);
    assert.match(output.hookSpecificOutput.additionalContext, /next hook\/PreToolUse capacity check/);
  });
});

test("zero budget guidance rejects send_input and requires capacity refresh after close", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open'),('parent1','a6','open');",
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "Send messages to two existing agents, then use one more explorer if needed.",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(context, /ZERO_BUDGET_RECOVERY_REQUIRED=true/);
    assert.match(context, /reuse a compatible current-parent lane with send_input/);
    assert.match(context, /close exactly one listed current-parent lane/);
    assert.match(context, /send_input and wait_agent do not increase the spawn budget/);
    assert.match(context, /If close_agent succeeds, re-check capacity before any spawn/);
    assert.match(context, /older zero-budget snapshot is no longer authoritative/);
  });
});

test("prompt-time guidance requires explicit model-selection judgment when spawn hooks are bypassed", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "Let subagents investigate in parallel with explorer lanes.",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /SUBAGENT_MODEL_SELECTION_REQUIRED=true/);
    assert.match(context, /SUBAGENT_MODEL_DECISION_REQUIRED=true/);
    assert.match(context, /task_contract=\{output,risk,state_depth,context_size,edit_permission,final_authority,output_cap,stop_condition\}/);
    assert.match(context, /Every spawn_agent call/);
    assert.match(context, /default to model=\"gpt-5\.4-mini\"/);
    assert.match(context, /model=\"gpt-5\.3-codex-spark\"/);
    assert.match(context, /model=\"gpt-5\.4-mini\"/);
    assert.match(context, /model=\"gpt-5\.5\"/);
    assert.match(context, /strict output cap/);
    assert.match(context, /If you cannot state the child output cap and stop condition, do not use Spark/);
    assert.match(context, /Do not launch multiple lanes just because there are multiple perspectives/);
    assert.match(context, /large-context repos, first make a local module\/file map/);
    assert.match(context, /This judgment step is mandatory/);
    assert.match(context, /omitted model inherits the parent frontier model/);
    assert.match(context, /not a recommendation to create a subagent/);
  });
});

test("child session user prompts receive no proactive subagent guidance", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const transcript = join(home, "child.jsonl");
    await writeFile(
      transcript,
      JSON.stringify({
        timestamp: "2026-05-16T08:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "child1",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent1" } } },
        },
      }),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "child1",
      transcript_path: transcript,
      prompt: "Use reviewers and verifier agents in parallel.",
    });

    assert.equal(output, null);
  });
});

test("installer is idempotent for existing hooks.json", async () => {
  await withHome(async (home) => {
    await runScript(installPath, home);
    await runScript(installPath, home);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    for (const eventName of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      const count = config.hooks[eventName]
        .flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.command.includes("native-agent-pool-advisor.mjs")).length;
      assert.equal(count, 1, eventName);
    }
    const sessionStartEntry = config.hooks.SessionStart.find((entry) => {
      return (entry.hooks ?? []).some((hook) => hook.command.includes("native-agent-pool-advisor.mjs"));
    });
    assert.equal(sessionStartEntry.matcher, "startup|resume");
  });
});

test("installer restores SessionStart advisor when a startup self-heal removed it", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "hooks"), { recursive: true });
    await writeFile(
      join(home, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [{ type: "command", command: `node "${join(home, "hooks", "quiet-omx-status-self-heal.mjs")}"` }],
            },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: `node "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"` }] },
          ],
          PreToolUse: [
            { hooks: [{ type: "command", command: `node "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"` }] },
          ],
          PostToolUse: [
            { hooks: [{ type: "command", command: `node "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"` }] },
          ],
        },
      }),
    );

    await runScript(installPath, home);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    const entries = config.hooks.SessionStart;
    const advisorEntries = entries.filter((entry) => {
      return (entry.hooks ?? []).some((hook) => hook.command.includes("native-agent-pool-advisor.mjs"));
    });
    assert.equal(advisorEntries.length, 1);
    assert.equal(advisorEntries[0].matcher, "startup|resume");
  });
});

test("doctor validates install and uninstall removes advisor registrations", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await runScript(installPath, home);
    const doctor = JSON.parse((await runScript(doctorPath, home)).stdout);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.checks.registrations.SessionStart, 1);
    assert.equal(doctor.checks.registrations.UserPromptSubmit, 1);
    assert.equal(doctor.runtime_capabilities.registration_verified_only, true);
    assert.equal(doctor.runtime_capabilities.native_spawn_pre_tool_use_hard_block, "not_documented");

    const dryRun = JSON.parse((await runScript(uninstallPath, home, ["--dry-run"])).stdout);
    assert.equal(dryRun.removed_registrations, 4);

    const removed = JSON.parse((await runScript(uninstallPath, home)).stdout);
    assert.equal(removed.removed_registrations, 4);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    for (const eventName of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      const entries = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
      const count = entries
        .flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.command.includes("native-agent-pool-advisor.mjs")).length;
      assert.equal(count, 0, eventName);
    }
  });
});

test("live-check detects real missing-model native spawn bypass evidence", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Test E2E','explorer','gpt-5.5','low','Mencius','/tmp',1779074894);",
    );
    const transcript = join(home, "parent.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"explorer\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"E2E hook test only\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Mencius\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.verdict, "native_spawn_missing_model_bypassed_advisor");
    assert.equal(output.spawn_calls[0].has_model, false);
    assert.equal(output.spawn_calls[0].created_agent_id, "child1");
    assert.equal(output.spawn_calls[0].native_edge.model, "gpt-5.5");
  });
});

test("live-check verifies explicit model routes, closes, and current open count", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','spark1','closed'),('parent1','mini1','closed'),('parent1','frontier1','closed');",
        "insert into threads values ('spark1','/tmp/spark.jsonl','SPARK_LANE_OK','explorer','gpt-5.3-codex-spark','low','Franklin','/tmp',1779075987);",
        "insert into threads values ('mini1','/tmp/mini.jsonl','MINI_LANE_OK','explorer','gpt-5.4-mini','medium','Gibbs','/tmp',1779076009);",
        "insert into threads values ('frontier1','/tmp/frontier.jsonl','FRONTIER_LANE_OK','default','gpt-5.5','low','Mendel','/tmp',1779076031);",
      ].join(""),
    );
    const transcript = join(home, "parent-models.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spark","arguments":"{\\"agent_type\\":\\"explorer\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"SPARK_LANE_OK\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"spark","output":"{\\"agent_id\\":\\"spark1\\",\\"nickname\\":\\"Franklin\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-spark","arguments":"{\\"target\\":\\"spark1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"close-spark","output":"{\\"previous_status\\":{\\"completed\\":\\"SPARK_LANE_OK\\"}}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"mini","arguments":"{\\"agent_type\\":\\"explorer\\",\\"model\\":\\"gpt-5.4-mini\\",\\"reasoning_effort\\":\\"medium\\",\\"message\\":\\"MINI_LANE_OK\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"mini","output":"{\\"agent_id\\":\\"mini1\\",\\"nickname\\":\\"Gibbs\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-mini","arguments":"{\\"target\\":\\"mini1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"close-mini","output":"{\\"previous_status\\":{\\"completed\\":\\"MINI_LANE_OK\\"}}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"frontier","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.5\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"FRONTIER_LANE_OK\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"frontier","output":"{\\"agent_id\\":\\"frontier1\\",\\"nickname\\":\\"Mendel\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-frontier","arguments":"{\\"target\\":\\"frontier1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"close-frontier","output":"{\\"previous_status\\":{\\"completed\\":\\"FRONTIER_LANE_OK\\"}}"}}',
      ].join("\n"),
    );

    const result = JSON.parse((await runScript(liveCheckPath, home, [
      "--transcript", transcript,
      "--expect-model", "gpt-5.3-codex-spark",
      "--expect-model", "gpt-5.4-mini",
      "--expect-model", "gpt-5.5",
      "--expect-current-open", "0",
      "--expect-all-closed",
      "--allow-missing-guidance",
    ])).stdout);

    assert.equal(result.ok, true);
    assert.equal(result.check_status, "passed");
    assert.equal(result.model_routes.length, 3);
    assert.equal(result.checks.find((check) => check.name === "model_recorded:gpt-5.4-mini").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "current_parent_open_count").evidence, "open=0, expected=0");
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

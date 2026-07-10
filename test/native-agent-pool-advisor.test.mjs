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
const doctorPath = join(repoRoot, "scripts", "doctor.mjs");
const liveCheckPath = join(repoRoot, "scripts", "live-check.mjs");
const resetPath = join(repoRoot, "scripts", "reset-pool.mjs");

async function withHome(work, config = "[agents]\nmax_threads = 6\n") {
  const home = await mkdtemp(join(tmpdir(), "native-agent-pool-advisor-test-"));
  try {
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(join(home, "config.toml"), config);
    return await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function sqlite(home, sql) {
  return execFileAsync("sqlite3", [join(home, "state_5.sqlite"), sql], { timeout: 5000, maxBuffer: 1024 * 1024 });
}

async function sqliteReadonly(home, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", join(home, "state_5.sqlite"), sql], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createNativeTables(home) {
  await sqlite(home, [
    "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
    "create table threads(id text, model text, reasoning_effort text, archived integer default 0);",
  ].join(" "));
}

async function runHook(home, payload) {
  const child = spawn(process.execPath, [hookPath], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hook timed out"));
    }, 5000);
    child.on("error", reject);
    child.on("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(code, 0, stderr);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function runScript(path, home, args = []) {
  return execFileAsync(process.execPath, [path, ...args], { env: { ...process.env, CODEX_HOME: home }, timeout: 8000, maxBuffer: 1024 * 1024 });
}

function spawnPayload(overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "spawn_agent",
    session_id: "parent1",
    tool_input: {
      agent_type: "explorer",
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      message: "independent hardest judgment",
      ...overrides,
    },
  };
}

test("explicit Sol route is accepted for any role", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    assert.equal(await runHook(home, spawnPayload()), null);
  });
});

test("spawn requires explicit model and effort", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const missingModel = await runHook(home, spawnPayload({ model: "" }));
    assert.equal(missingModel.decision, "block");
    assert.match(missingModel.reason, /model must explicitly/);
    const missingEffort = await runHook(home, spawnPayload({ reasoning_effort: "" }));
    assert.equal(missingEffort.decision, "block");
    assert.match(missingEffort.reason, /reasoning_effort must explicitly/);
  });
});

test("fork context is blocked because it inherits parent routing", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, spawnPayload({ fork_context: true }));
    assert.equal(output.decision, "block");
    assert.match(output.reason, /fork_context inherits parent route/);
  });
});

test("admission uses only current-parent native edges and honors the six-slot cap", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('other','o1','open'),('other','o2','open'),('other','o3','open'),('other','o4','open'),('other','o5','open'),('other','o6','open');");
    assert.equal(await runHook(home, spawnPayload()), null);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open'),('parent1','a6','open');");
    const output = await runHook(home, spawnPayload());
    assert.equal(output.decision, "block");
    assert.match(output.reason, /6\/6 native slots occupied/);
  });
});

test("batch admission counts every native spawn in the same tool call", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open');");
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "multi_tool_use.parallel",
      session_id: "parent1",
      tool_input: {
        tool_uses: [
          { recipient_name: "functions.spawn_agent", parameters: spawnPayload().tool_input },
          { recipient_name: "functions.spawn_agent", parameters: { ...spawnPayload().tool_input, model: "gpt-5.6-luna", reasoning_effort: "low" } },
        ],
      },
    });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /requests 2/);
  });
});

test("close requires exact current-parent child id and never mutates native DB", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");
    const bad = await runHook(home, { hook_event_name: "PreToolUse", tool_name: "close_agent", session_id: "parent1", tool_input: { target: "Nickname" } });
    assert.equal(bad.decision, "block");
    assert.equal(await runHook(home, { hook_event_name: "PreToolUse", tool_name: "close_agent", session_id: "parent1", tool_input: { target: "child1" } }), null);
    await runHook(home, { hook_event_name: "PostToolUse", tool_name: "close_agent", session_id: "parent1", tool_input: { target: "child1" }, tool_response: "agent with id child1 not found" });
    assert.equal(await sqliteReadonly(home, "select status from thread_spawn_edges where child_thread_id='child1';"), "open");
  });
});

test("unreadable native state blocks instead of transcript or local-state fallback", async () => {
  await withHome(async (home) => {
    const output = await runHook(home, spawnPayload());
    assert.equal(output.decision, "block");
    assert.match(output.reason, /thread_spawn_edges are unreadable/);
  });
});

test("unsupported codex exec worker fallback is blocked", async () => {
  await withHome(async (home) => {
    const output = await runHook(home, { hook_event_name: "PreToolUse", tool_name: "shell", session_id: "parent1", tool_input: { command: "codex exec --model gpt-5.6-terra" } });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /unsupported fallback/);
  });
});

test("transcript hygiene removes failed legacy agent operations but preserves user evidence", async () => {
  await withHome(async (home) => {
    const transcript = join(home, "parent.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "session_meta", payload: { id: "parent1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "验证保留。我把这版交给同一个独立代理再尝试构造反例。" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "followup_task", call_id: "call1", arguments: '{"target":"yes_path_trace"}' } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call1", output: "live agent path `/root/yes_path_trace` not found" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "保留：我要先看当前证据。" }] } }),
    ].join("\n"));
    await runHook(home, { hook_event_name: "UserPromptSubmit", session_id: "parent1", transcript_path: transcript, prompt: "continue" });
    const text = await readFile(transcript, "utf-8");
    assert.match(text, /验证保留/);
    assert.match(text, /保留：我要先看当前证据/);
    assert.doesNotMatch(text, /独立代理|yes_path_trace|live agent path/i);
    assert.match(text, /removed-native-agent-operation-status/);
  });
});

test("install retires watcher and registers only read-only control points", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await mkdir(join(home, "hooks"), { recursive: true });
    await writeFile(join(home, "hooks", "native-agent-pool-global-state-watch.mjs"), "legacy");
    await runScript(installPath, home);
    const doctor = JSON.parse((await runScript(doctorPath, home)).stdout);
    assert.equal(doctor.ok, true);
    assert.deepEqual(doctor.checks.registrations, { SessionStart: 1, UserPromptSubmit: 1, PreToolUse: 1, PostCompact: 1 });
    assert.deepEqual(doctor.checks.retired_registrations, { PostToolUse: 0, PreCompact: 0 });
    const hooks = await readFile(join(home, "hooks.json"), "utf-8");
    assert.doesNotMatch(hooks, /PostToolUse|PreCompact/);
  });
});

test("reset command is an inspection and cannot mutate native edges", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");
    const result = JSON.parse((await runScript(resetPath, home, ["--parent", "parent1"])).stdout);
    assert.equal(result.read_only, true);
    assert.equal(await sqliteReadonly(home, "select status from thread_spawn_edges where child_thread_id='child1';"), "open");
  });
});

test("live check proves explicit route and native row agreement without role restrictions", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open'); insert into threads values ('child1','gpt-5.6-sol','xhigh',0);");
    const transcript = join(home, "live.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "session_meta", payload: { id: "parent1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "spawn1", arguments: '{"agent_type":"explorer","model":"gpt-5.6-sol","reasoning_effort":"xhigh"}' } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "spawn1", output: '{"agent_id":"child1"}' } }),
    ].join("\n"));
    const result = JSON.parse((await runScript(liveCheckPath, home, ["--transcript", transcript, "--expect-model", "gpt-5.6-sol", "--expect-current-open", "1"])).stdout);
    assert.equal(result.ok, true);
  });
});

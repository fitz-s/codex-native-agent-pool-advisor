import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

async function createNativeTablesWithArchiveColumns(home) {
  await sqlite(
    home,
    [
      "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
      "create table threads(id text, rollout_path text, title text, agent_role text, model text, reasoning_effort text, agent_nickname text, cwd text, updated_at integer, thread_source text, archived integer, archived_at integer);",
    ].join(" "),
  );
}

async function createNativeTablesWithSourceAndArchiveNoArchivedAt(home) {
  await sqlite(
    home,
    [
      "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
      "create table threads(id text, rollout_path text, title text, agent_role text, model text, reasoning_effort text, agent_nickname text, cwd text, updated_at integer, source text, thread_source text, archived integer);",
    ].join(" "),
  );
}

async function createNativeTablesWithSourceAndArchiveColumns(home) {
  await sqlite(
    home,
    [
      "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
      "create table threads(id text, rollout_path text, title text, agent_role text, model text, reasoning_effort text, agent_nickname text, cwd text, updated_at integer, source text, thread_source text, archived integer, archived_at integer);",
    ].join(" "),
  );
}

function subagentSource(parentId, nickname = "Agent", role = "default") {
  return JSON.stringify({
    subagent: {
      thread_spawn: {
        parent_thread_id: parentId,
        depth: 1,
        agent_path: null,
        agent_nickname: nickname,
        agent_role: role,
      },
    },
  }).replace(/'/g, "''");
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
    await sqlite(
      home,
      "insert into threads values "
        + "('a1','/tmp/a1.jsonl','Active lane one','debugger','gpt-5.4-mini','high','Boyle','/repo',1779076001),"
        + "('a2','/tmp/a2.jsonl','Active lane two','code-reviewer','gpt-5.5','high','Avicenna','/repo',1779076002),"
        + "('a3','/tmp/a3.jsonl','Active lane three','critic','gpt-5.5','high','Pascal','/repo',1779076003),"
        + "('a4','/tmp/a4.jsonl','Active lane four','debugger','gpt-5.4-mini','high','Dirac','/repo',1779076004),"
        + "('a5','/tmp/a5.jsonl','Active lane five','debugger','gpt-5.4-mini','high','Linnaeus','/repo',1779076005),"
        + "('a6','/tmp/a6.jsonl','Active lane six','debugger','gpt-5.4-mini','high','Euler','/repo',1779076006);",
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
              agent_type: "default",
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
    assert.match(output.reason, /LANES_OPEN=6/);
    assert.match(output.reason, /agent_id=a1/);
    assert.match(output.reason, /role=debugger/);
    assert.match(output.reason, /model=gpt-5\.4-mini/);
    assert.doesNotMatch(output.reason, /nick=Boyle/);
    assert.doesNotMatch(output.reason, /Active lane one/);
    assert.match(output.reason, /close listed current-parent lane/);
    assert.match(output.reason, /Do not convert pool-full into a silent local-only plan/);
  });
});

test("missing native edge database blocks spawn conservatively", async () => {
  await withHome(async (home) => {
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
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
        agent_type: "default",
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
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.notEqual(output?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:empty-parent"].spawn_reservations);
    assert.equal(reservations.length, 0);
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

    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=6/);
    assert.match(context, /batch_guarantee=false/);
    assert.match(context, /observed_free=6/);
    assert.match(context, /remaining_spawn_budget=6/);
    assert.match(context, /SPAWN_AGENT_DISABLED_THIS_TURN=false/);
    assert.match(context, /SUBAGENTS_AVAILABLE_FOR_VALUEFUL_PARALLEL_WORK=true/);
    assert.match(context, /recommended_protocol=reuse_or_spawn_when_subagent_value_then_resample/);
    assert.match(context, /choose reuse or spawn with explicit model and bounded task contract/);
    assert.match(context, /positive observed_free snapshot as the current authority/);
    assert.match(context, /Do not report native subagent capacity as 0/);
    assert.match(context, /NATIVE_SPAWN_SHAPE_CONTRACT=true/);
    assert.match(context, /Choose native agent_type deliberately/);
    assert.match(context, /not an atomic runtime reservation/);
    assert.match(context, /native_slots=slot_open=0/);
    assert.doesNotMatch(context, /When observed_free is 0, do not call spawn_agent/);
    assert.doesNotMatch(context, /ZERO_BUDGET_RECOVERY_REQUIRED=true/);
    assert.doesNotMatch(context, /does not recommend delegation/);
    assert.doesNotMatch(context, /native_global/);
    assert.doesNotMatch(context, /Global native/);
  });
});

test("prompt-time guidance requires lane reuse check when current-parent lanes exist", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");
    await sqlite(
      home,
      "insert into threads values ('child1','/tmp/child1.jsonl','Zeus oracle wiring verifier','explorer','gpt-5.4-mini','medium','Pasteur','/repo',1779076009);",
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "Spawn another verifier for Zeus oracle wiring.",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /SPAWN_AGENT_OBSERVED_FREE=5/);
    assert.match(context, /LANE_REUSE_CHECK_REQUIRED=true/);
    assert.match(context, /agent_id=child1/);
    assert.match(context, /model=gpt-5\.4-mini/);
    assert.doesNotMatch(context, /nick=Pasteur/);
    assert.match(context, /LANES_OPEN=1/);
    assert.match(context, /updated_at=/);
    assert.doesNotMatch(context, /Zeus oracle wiring verifier/);
    assert.match(context, /use send_input to reuse it/);
    assert.match(context, /do not close a still-running, task-critical lane merely to make room/);
    assert.match(context, /Completed_not_closed lanes are already finished/);
  });
});

test("prompt-mentioned stale agent ids are not treated as current close targets", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const closedId = "019efe2f-583a-71b2-a372-b01c567b376f";
    const openId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    await sqlite(
      home,
      `insert into thread_spawn_edges values ('parent1','${closedId}','closed'),('parent1','${openId}','open');`,
    );
    await sqlite(
      home,
      "insert into threads values "
        + `('${closedId}','/tmp/closed.jsonl','Plato stale title','explore','gpt-5.3-codex-spark','high','Plato','/repo',1779074000,'{}','{}',1,1779074001),`
        + `('${openId}','/tmp/open.jsonl','Current debugger','debugger','gpt-5.4-mini','high','Averroes','/repo',1779076002,'{}','{}',0,0);`,
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: `我找到了当前真实存在的三个 agent id：${closedId}、${openId}。按要求只关这些存在的。`,
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /MENTIONED_AGENT_ID_STATUS_AUDIT=1/);
    assert.match(context, /MENTIONED_AGENT_ID_NOT_CURRENT\(id=\[not-current-agent-id\]/);
    assert.doesNotMatch(context, new RegExp(closedId));
    assert.match(context, /status=(closed|no_edge)/);
    assert.match(context, /archived=1/);
    assert.doesNotMatch(context, new RegExp(`MENTIONED_AGENT_ID_NOT_CURRENT\\(id=${openId}`));
    assert.doesNotMatch(context, /Plato/);
    assert.match(context, /Do not close, reuse, or count these mentioned ids as current open lanes/);
    assert.match(context, /Use the current parent\/session capacity snapshot and LANES_OPEN inventory instead/);
  });
});

test("quoted close-status display names are not treated as current close targets", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const staleId = "019efe2f-583a-71b2-a372-b01c567b376f";
    const completedId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    const completedTranscript = await writeTaskCompleteTranscript(home, completedId);
    await sqlite(
      home,
      `insert into thread_spawn_edges values ('parent1','${staleId}','closed'),('parent1','${completedId}','open');`,
    );
    await sqlite(
      home,
      "insert into threads values "
        + `('${staleId}','/tmp/stale.jsonl','Archived display lane','explore','gpt-5.3-codex-spark','high','Plato','/repo',1779074000,'{}','{}',1,1779074001),`
        + `('${completedId}','${completedTranscript.replace(/'/g, "''")}','Completed verifier','verifier','gpt-5.4-mini','high','Averroes','/repo',1779076002,'{}','{}',0,0);`,
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: [
        "正在关闭正在关闭1 个智能体",
        "正在关闭 Plato (explore)",
        "plato又在被关闭",
      ].join("\n"),
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /QUOTED_CLOSE_STATUS_IS_NOT_AGENT_INVENTORY=true/);
    assert.match(context, /Never derive a close_agent target from a quoted display name/);
    assert.match(context, new RegExp(`CURRENT_PARENT_CLOSE_CANDIDATES=${completedId}`));
    assert.doesNotMatch(context, /Plato/i);
    assert.doesNotMatch(context, new RegExp(staleId));
  });
});

test("quoted close-status thread titles are sanitized before agent context reuse", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    await sqlite(
      home,
      "insert into threads values "
        + "('parent1','/tmp/parent.jsonl','正在关闭正在关闭1 个智能体 正在关闭 Plato (explore)','', '', '', '', '/repo',1779076002,'{}','{}',0,0);",
    );

    await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "继续处理 native agent 卡死，不要从标题注入 display name。",
    });

    const title = await sqliteReadonly(home, "select title from threads where id='parent1';");
    assert.equal(title, "Native subagent close-status contamination repair");
    assert.doesNotMatch(title, /Plato/i);
  });
});

test("transcript native display labels are scrubbed without DB identity", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const transcript = join(home, "parent1.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"message","text":"正在关闭正在关闭1 个智能体 正在关闭 Dirac (architect)"}}',
        '{"type":"response_item","payload":{"type":"message","text":"无法关闭3 个智能体 无法关闭 Darwin (debugger)"}}',
        '{"type":"response_item","payload":{"type":"message","text":"创建中 Gibbs (debugger)"}}',
        '{"type":"response_item","payload":{"type":"message","text":"Agent \\"Feynman\\" completed · 0s"}}',
        '{"type":"response_item","payload":{"type":"message","text":"Hubble又在被关闭"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Jason\\"}"}}',
      ].join("\n"),
    );

    await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "continue",
    });

    const text = await readFile(transcript, "utf-8");
    assert.doesNotMatch(text, /无法关闭|Dirac|Darwin|Feynman|Gibbs|Hubble|Jason/);
    assert.match(text, /\[removed-native-display-label\]/);
    assert.doesNotMatch(text, /child1/);
    assert.match(text, /\[removed-native-agent-id\]/);
  });
});

test("removed native display label is sanitized from current transcript before context reuse", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const transcript = join(home, "parent-transcript.jsonl");
    const displayLabel = "[removed" + "-native-display-label]";
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        JSON.stringify({ type: "response_item", payload: { type: "message", text: `quoted ${displayLabel}` } }),
      ].join("\n"),
    );

    await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "continue",
    });

    const text = await readFile(transcript, "utf-8");
    assert.doesNotMatch(text, new RegExp(displayLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /removed native close-status display label/);
  });
});

test("global state native display labels are scrubbed before context reuse", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','archived-019f1e1d','code-reviewer','gpt-5.5','high','archived-019f1e1d','/repo',1779076002,'{}','subagent',1,1779076003);",
    );
    const globalState = join(home, ".codex-global-state.json");
    await writeFile(
      globalState,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "prompt-history": {
            global: [
              "已创建1 个智能体已使用以下指令创建 Averroes (code-reviewer)",
              "正在关闭正在关闭1 个智能体正在关闭 Averroes (code-reviewer)",
              "Averroes review has not returned yet",
              "子任务已启动：Averroes 查 DB 锁。",
              "Averroes 的数学线已经返回：q 本身是 settlement-preimage。",
              "当前父会话里还有 5 个旧 subagent 槽位。",
              "<subagents>\\n    - 019f04b9-97c2-7783-8ce4-d4f15c72cecb: Averroes the 2nd\\n</subagents>",
              "正在关闭正在关闭1 个智能体正在关闭 Ohm (verifier)",
              "The verifier did not return within the short check window. I'm closing it now rather than holding the goal turn open on a non-critical sidecar.\n\n\n\n\n正在关闭正在关闭1 个智能体正在关闭 Ohm (verifier)",
              "无法关闭3 个智能体无法关闭 Galileo the 3rd (debugger)",
            ],
          },
          "composer-prompt-drafts-v1": {
            "local:parent1": "正在关闭正在关闭1 个智能体正在关闭 Plato (explore)",
          },
          draft: {
            agent_nickname: "Ohm",
          },
        },
      }),
    );

    await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "continue",
    });

    const text = await readFile(globalState, "utf-8");
    assert.doesNotMatch(text, /Averroes|Ohm|Plato|Galileo the 3rd|The verifier did not return|closing it now|已创建1 个智能体|正在关闭1 个智能体|无法关闭3 个智能体|当前父会话里还有 5 个旧 subagent 槽位/);
    assert.doesNotMatch(text, /\[archived-child\]\s*\((?:explore|debugger|verifier|code-reviewer)\)/);
    assert.match(text, /removed native close-status display label/);

    await writeFile(globalState, '{"prompt-history":["line\\nAverroes review has not returned yet","\\[removed native close-status display label]"]}');
    const parentTranscript = join(home, "parent1.jsonl");
    await writeFile(parentTranscript, '{"type":"session_meta","payload":{"id":"parent1"}}\n');

    await runHook(home, {
      hook_event_name: "PostToolUse",
      session_id: "parent1",
      transcript_path: parentTranscript,
      tool_name: "shell",
      tool_input: {},
      tool_response: {},
    });

    const postToolText = await readFile(globalState, "utf-8");
    assert.doesNotMatch(postToolText, /Averroes/);
    assert.doesNotMatch(postToolText, /\\\[removed native close-status display label\]/);
    assert.doesNotThrow(() => JSON.parse(postToolText));

    await writeFile(
      globalState,
      JSON.stringify({
          "prompt-history": [
            "正在关闭正在关闭1 个智能体正在关闭 Averroes (code-reviewer)",
            "line\\nAverroes 还没返回",
            "line\\nAverroes 查 DB 锁",
          ],
      }),
    );

    await runHook(home, {
      hook_event_name: "PreToolUse",
      session_id: "parent1",
      transcript_path: parentTranscript,
      tool_name: "shell",
      tool_input: {},
    });

    const preToolText = await readFile(globalState, "utf-8");
    assert.doesNotMatch(preToolText, /Averroes|正在关闭1 个智能体/);
  });
});

test("pre-tool close guard blocks stale archived nickname targets before runtime", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const closedId = "019efe2f-583a-71b2-a372-b01c567b376f";
    const closeCandidateId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    const closeCandidateTranscript = await writeTaskCompleteTranscript(home, closeCandidateId);
    await sqlite(
      home,
      `insert into thread_spawn_edges values ('parent1','${closedId}','closed'),('parent1','${closeCandidateId}','open');`,
    );
    await sqlite(
      home,
      "insert into threads values "
        + `('${closedId}','/tmp/closed.jsonl','Stale lane','explore','gpt-5.3-codex-spark','high','Plato','/repo',1779074000,'{}','{}',1,1779074001),`
        + `('${closeCandidateId}','${closeCandidateTranscript.replace(/'/g, "''")}','Completed verifier','verifier','gpt-5.4-mini','high','Averroes','/repo',1779076002,'{}','{}',0,0);`,
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: {
        target: "Plato",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /Native agent close guard/);
    assert.match(output.reason, /BLOCKED_CLOSE_TARGET\(ref_type=name/);
    assert.match(output.reason, new RegExp(`matched_id=${closedId}`));
    assert.match(output.reason, /status=(closed|no_edge)/);
    assert.match(output.reason, /archived=1/);
    assert.match(output.reason, new RegExp(`CURRENT_PARENT_CLOSE_CANDIDATES=.*${closeCandidateId}`));
    assert.doesNotMatch(output.reason, /Plato/);
    assert.match(output.reason, /Do not retry this close target/);
  });
});

test("pre-tool close guard allows current-parent open id targets", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const openId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    await sqlite(home, `insert into thread_spawn_edges values ('parent1','${openId}','open');`);
    await sqlite(
      home,
      `insert into threads values ('${openId}','/tmp/open.jsonl','Current debugger','debugger','gpt-5.4-mini','high','Averroes','/repo',1779076002,'{}','{}',0,0);`,
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: {
        target: openId,
      },
    });

    assert.notEqual(output?.decision, "block");
    assert.doesNotMatch(output?.hookSpecificOutput?.additionalContext ?? "", /Native agent close guard/);
  });
});

test("pre-tool close guard blocks current-parent display-name targets before runtime", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const openId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    await sqlite(home, `insert into thread_spawn_edges values ('parent1','${openId}','open');`);
    await sqlite(
      home,
      `insert into threads values ('${openId}','/tmp/open.jsonl','Current debugger','debugger','gpt-5.4-mini','high','Plato','/repo',1779076002,'{}','{}',0,0);`,
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: {
        target: "Plato",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /display_ref_not_agent_id/);
    assert.match(output.reason, new RegExp(`matched_id=${openId}`));
    assert.match(output.reason, /CURRENT_PARENT_CLOSE_CANDIDATES=none/);
    assert.match(output.reason, /only admissible retry target is that exact matched_id value/);
    assert.doesNotMatch(output.reason, /Plato/);
  });
});

test("positive prompt guidance exposes max spawn batch and three-lane admission gate", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 4; index += 1) {
      const id = `active${index}`;
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','/tmp/${id}.jsonl','active ${index}','debugger','gpt-5.4-mini','high','Active ${index}','/tmp',177907500${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "open three bounded agents",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /SPAWN_AGENT_OBSERVED_FREE=2/);
    assert.match(context, /MAX_SPAWN_BATCH_NOW=2/);
    assert.match(context, /requested_spawns=3/);
    assert.match(context, /close_needed_for_request=1/);
    assert.match(context, /TWO_LANE_PLAN_ALLOWED=yes/);
    assert.match(context, /THREE_LANE_PLAN_ALLOWED=no/);
    assert.match(context, /do not launch a partial batch and let the remainder hit thread limit/);
  });
});

test("two-lane prompt with only one free slot requires reducing batch or closing first", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 5; index += 1) {
      const id = `active${index}`;
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','/tmp/${id}.jsonl','active ${index}','debugger','gpt-5.4-mini','high','Active ${index}','/tmp',177907500${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "我会并行开两个只读子任务：一个追 Day0 事件，另一个追 buy_yes admission。",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /SPAWN_AGENT_OBSERVED_FREE=1/);
    assert.match(context, /MAX_SPAWN_BATCH_NOW=1/);
    assert.match(context, /requested_spawns=2/);
    assert.match(context, /close_needed_for_request=1/);
    assert.match(context, /TWO_LANE_PLAN_ALLOWED=no/);
    assert.match(context, /close_needed_for_two=1/);
    assert.match(context, /do not launch a partial batch and let the remainder hit thread limit/);
    assert.match(context, /either reduce the batch to MAX_SPAWN_BATCH_NOW or close enough completed_not_closed lane\(s\) for the whole intended batch/);
  });
});

test("Chinese parallel child-task prompt bypasses recent prompt guidance TTL for batch capacity", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 4; index += 1) {
      const id = `active${index}`;
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','/tmp/${id}.jsonl','active ${index}','debugger','gpt-5.4-mini','high','Active ${index}','/tmp',177907500${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);
    await writeFile(
      join(home, "state", "native-agent-pool-advisor.json"),
      JSON.stringify({
        version: 1,
        sessions: {
          "thread:parent1": {
            last_capacity_prompt_guidance_at: new Date().toISOString(),
            last_capacity_prompt_signature: "recent-different-prompt",
          },
        },
      }),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "我会并行开三个只读子任务：预报 fusion、entry 数学、monitor redecision。",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /SPAWN_AGENT_OBSERVED_FREE=2/);
    assert.match(context, /MAX_SPAWN_BATCH_NOW=2/);
    assert.match(context, /requested_spawns=3/);
    assert.match(context, /close_needed_for_request=1/);
    assert.match(context, /TWO_LANE_PLAN_ALLOWED=yes/);
    assert.match(context, /THREE_LANE_PLAN_ALLOWED=no/);
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
            parameters: { agent_type: "default", message: "grep task" },
          },
        ],
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /explicit model/);
    assert.match(output.reason, /Default to gpt-5\.6-terra/);
    assert.match(output.reason, /gpt-5\.6-luna/);
    assert.match(output.reason, /gpt-5\.6-sol/);
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
        agent_type: "default",
        message: "Implement a bounded low-risk fix.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /explicit model/);
    assert.match(output.reason, /Default to gpt-5\.6-terra/);
    assert.match(output.reason, /model-selection judgment/);
  });
});

test("allows special native agent_type attempts when capacity and model shape are valid", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    for (const role of ["researcher", "critic", "code-reviewer"]) {
      const output = await runHook(home, {
        hook_event_name: "PreToolUse",
        tool_name: "spawn_agent",
        session_id: `parent-${role}`,
        tool_input: {
          agent_type: role,
          model: "gpt-5.6-terra",
          reasoning_effort: "high",
          message: "External reference research with links.",
        },
      });

      assert.notEqual(output?.decision, "block");
    }
  });
});

test("blocks special native agent_type without an explicit model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "code-reviewer",
        message: "Review the current diff.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /explicit model from the gpt-5\.6 family/);
  });
});

test("does not let special native agent_type bypass capacity limits", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','a1','open'),('parent1','a2','open'),('parent1','a3','open'),('parent1','a4','open'),('parent1','a5','open'),('parent1','a6','open');",
    );
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "code-reviewer",
        model: "gpt-5.5",
        reasoning_effort: "high",
        message: "Review the current diff.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /observed_free=0/);
    assert.match(output.reason, /close/);
  });
});

test("treats null blank and non-string model values as missing model selection", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const badModels = [null, "", "   ", { name: "gpt-5.6-terra" }];
    for (let index = 0; index < badModels.length; index += 1) {
      const output = await runHook(home, {
        hook_event_name: "PreToolUse",
        tool_name: "spawn_agent",
        session_id: `parent-bad-model-${index}`,
        tool_input: {
          agent_type: "default",
          model: badModels[index],
          reasoning_effort: "low",
          message: "map files",
        },
      });

      assert.equal(output.decision, "block");
      assert.match(output.reason, /explicit model/);
    }
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
        agent_type: "default",
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

test("blocks fork_context spawn when it also specifies agent_type", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "debugger",
        fork_context: true,
        reasoning_effort: "high",
        message: "Trace with full context.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /fork_context=true cannot be combined with agent_type/);
    assert.match(output.reason, /Full-history forks cannot override role/);
    assert.match(output.reason, /remove fork_context/);
    assert.doesNotMatch(output.reason, /ZERO_BUDGET_RECOVERY_REQUIRED/);
    assert.doesNotMatch(output.reason, /observed_free=0/);
  });
});

test("does not treat string fork_context as the model-inheritance exception", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        fork_context: "true",
        reasoning_effort: "medium",
        message: "Trace with exact full history.",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /explicit model/);
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

test("post-tool advisory reports missing model when spawn hook was bypassed", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        reasoning_effort: "low",
        message: "map files",
      },
      tool_response: { agent_id: "child1", nickname: "Scout" },
    });

    assert.notEqual(output?.decision, "block");
    assert.match(output.hookSpecificOutput.additionalContext, /Missing model route violation observed after tool execution/);
    assert.match(output.hookSpecificOutput.additionalContext, /spawn_agent ran without an explicit model/);
  });
});

test("allows explicit frontier model for default critic lanes", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.5",
        reasoning_effort: "high",
        message: "Review architecture risk.",
      },
    });

    assert.notEqual(output?.decision, "block");
  });
});

test("allows Terra route for default spawns without persisting a reservation", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        message: "map files",
      },
    });

    assert.notEqual(output?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:parent1"].spawn_reservations);
    assert.equal(reservations.length, 0);
  });
});

test("unconfirmed pre-spawn attempts do not serialize a later spawn", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const first = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        message: "trace first slice",
      },
    });
    assert.notEqual(first?.decision, "block");

    const second = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        message: "trace second slice",
      },
    });

    assert.notEqual(second?.decision, "block");
  });
});

test("legacy persisted reservations are purged before admission", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const first = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        message: "trace first slice",
      },
    });
    assert.notEqual(first?.decision, "block");

    const statePath = join(home, "state", "native-agent-pool-advisor.json");
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    state.sessions["thread:parent1"].spawn_reservations = {
      legacy: { count: 6, expires_at: "2999-01-01T00:00:00.000Z" },
    };
    state.sessions["thread:other-parent"] = {
      session_id: "thread:other-parent",
      updated_at: new Date().toISOString(),
      agents: {},
      spawn_reservations: {
        legacy: { count: 6, expires_at: "2999-01-01T00:00:00.000Z" },
      },
    };
    await writeFile(statePath, JSON.stringify(state, null, 2));

    const second = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        message: "trace second slice",
      },
    });

    assert.notEqual(second?.decision, "block");
    const migrated = JSON.parse(await readFile(statePath, "utf-8"));
    assert.deepEqual(migrated.sessions["thread:parent1"].spawn_reservations, {});
    assert.deepEqual(migrated.sessions["thread:other-parent"].spawn_reservations, {});
  });
});

test("failed spawn output does not block corrected retry", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const first = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        message: "bounded review task",
      },
    });
    assert.equal(first, null);

    const beforeFailure = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        message: "second task before first result",
      },
    });
    assert.notEqual(beforeFailure?.decision, "block");

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        malformed: true,
      },
      tool_response: "spawn failed: invalid spawn_agent arguments",
    });

    const retry = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        message: "corrected bounded review task",
      },
    });
    assert.notEqual(retry?.decision, "block");
  });
});

test("failed wrapped spawn output does not block corrected retry", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const spawnParams = {
      agent_type: "default",
      model: "gpt-5.6-terra",
      reasoning_effort: "high",
      message: "wrapped bounded review task",
    };

    const first = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "multi_tool_use.parallel",
      session_id: "parent1",
      tool_input: {
        tool_uses: [{ recipient_name: "functions.spawn_agent", parameters: spawnParams }],
      },
    });
    assert.equal(first, null);

    const beforeFailure = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        message: "second task before wrapper result",
      },
    });
    assert.notEqual(beforeFailure?.decision, "block");

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "multi_tool_use.parallel",
      session_id: "parent1",
      tool_input: {
        tool_uses: [{ recipient_name: "functions.spawn_agent", parameters: { malformed: true } }],
      },
      tool_response: [{ recipient_name: "functions.spawn_agent", output: "spawn failed: invalid spawn_agent arguments" }],
    });

    const retry = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        message: "corrected bounded review task",
      },
    });
    assert.notEqual(retry?.decision, "block");
  });
});

test("blocks explorer role when it explicitly selects a frontier model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        message: "Architecture critic lane using explicit frontier model.",
      },
    });

    assert.equal(output?.decision, "block");
    assert.match(output.reason, /Explorer\/frontier route violation/);
    assert.match(output.reason, /agent_type=default/);
    assert.match(output.reason, /Do not use native explorer unless explicitly configured/);
  });
});

test("post-tool advisory reports explorer frontier route violation when spawn hook was bypassed", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "explorer",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        message: "Architecture critic lane using explicit frontier model.",
      },
      tool_response: { agent_id: "child1", nickname: "Hubble" },
    });

    assert.notEqual(output?.decision, "block");
    assert.match(output.hookSpecificOutput.additionalContext, /Explorer\/frontier route violation observed after tool execution/);
    assert.match(output.hookSpecificOutput.additionalContext, /frontier critic\/architecture lanes must use agent_type=default/i);
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
              agent_type: "default",
              model: "gpt-5.3-codex-spark",
              reasoning_effort: "low",
              message: "map files",
            },
          },
          {
            recipient_name: "functions.spawn_agent",
            parameters: {
              agent_type: "default",
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

test("allows wrapped multi-spawn when requested count fits observed capacity", async () => {
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
            parameters: {
              agent_type: "default",
              model: "gpt-5.3-codex-spark",
              reasoning_effort: "low",
              message: "map files",
            },
          },
          {
            recipient_name: "functions.spawn_agent",
            parameters: {
              agent_type: "default",
              model: "gpt-5.4-mini",
              reasoning_effort: "medium",
              message: "trace code path",
            },
          },
        ],
      },
    });

    assert.notEqual(output?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:parent1"].spawn_reservations);
    assert.equal(reservations.length, 0);
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
              agent_type: "default",
              model: "gpt-5.3-codex-spark",
              reasoning_effort: "low",
              message: "map files",
            },
          },
          {
            recipient_name: "functions.spawn_agent",
            parameters: {
              agent_type: "default",
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
        agent_type: "default",
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
              agent_type: "default",
              model: "gpt-5.3-codex-spark",
              reasoning_effort: "low",
              message: "map files",
            },
          },
          {
            recipient_name: "functions.spawn_agent",
            parameters: {
              agent_type: "default",
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

test("native-readable empty edges still count successful local spawn ledger until edges catch up", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
      tool_response: { agent_id: "child1", nickname: "Scout" },
    });

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map another file",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /1\/1 estimated slots occupied/);
    assert.match(output.reason, /slot_pressure_source=native_open_edges_plus_ledger/);
    assert.match(output.reason, /ledger_lag=1/);
  }, "[agents]\nmax_threads = 1\n");
});

test("stale local spawn ledger lag does not override authoritative native DB", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
      tool_response: { agent_id: "stale-ledger-child", nickname: "Scout" },
    });

    const statePath = join(home, "state", "native-agent-pool-advisor.json");
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    state.sessions["thread:parent1"].agents["stale-ledger-child"].last_seen_at = "2000-01-01T00:00:00.000Z";
    state.sessions["thread:parent1"].agents["stale-ledger-child"].spawned_at = "2000-01-01T00:00:00.000Z";
    await writeFile(statePath, JSON.stringify(state, null, 2));

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map another file",
      },
    });

    assert.notEqual(output?.decision, "block");
    const nextState = JSON.parse(await readFile(statePath, "utf-8"));
    assert.equal(nextState.sessions["thread:parent1"].agents["stale-ledger-child"], undefined);
  }, "[agents]\nmax_threads = 1\n");
});

test("native open edges with task_complete transcripts remain occupied close candidates", async () => {
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
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /native_slots=slot_open=0, slot_terminal=6, slot_estimate=6\/6/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /remaining_spawn_budget=0/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /CLOSE_BEFORE_SPAWN_REQUIRED=true/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /CLOSE_CANDIDATES=child1,child2,child3,child4,child5,child6/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /before any spawn_agent call/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /LANES_COMPLETED_NOT_CLOSED=6/);
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /close enough listed completed_not_closed current-parent lane\(s\)/);
    assert.equal(
      await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status order by status;"),
      "open|6",
    );

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.equal(spawnOutput?.decision, "block");
    assert.match(spawnOutput.reason, /6\/6 estimated slots occupied/);
    assert.match(spawnOutput.reason, /native_slots=slot_open=0, slot_terminal=6/);
    assert.match(spawnOutput.reason, /LANES_COMPLETED_NOT_CLOSED=6/);
    assert.match(spawnOutput.reason, /close enough listed completed_not_closed current-parent lane\(s\)/);
  });
});

test("overfull native open-edge evidence saturates occupied at the runtime cap", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 8; index += 1) {
      const id = `child${index}`;
      const path = await writeFalseTaskCompleteTranscript(home, id);
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
        agent_type: "default",
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

test("configured stale open edge repair closes only old current-parent lanes", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithArchiveColumns(home);
    const oldSeconds = Math.floor((Date.now() - (72 * 60 * 60 * 1000)) / 1000);
    const freshSeconds = Math.floor(Date.now() / 1000);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','old-child','open'),('parent1','fresh-child','open'),('parent2','other-old-child','open');",
        "insert into threads(id,rollout_path,title,agent_role,model,reasoning_effort,agent_nickname,cwd,updated_at,thread_source,archived,archived_at)",
        `values ('old-child','/tmp/old.jsonl','Old lane','debugger','gpt-5.4-mini','high','Old','/tmp',${oldSeconds},'subagent',0,null),`,
        `('fresh-child','/tmp/fresh.jsonl','Fresh lane','debugger','gpt-5.4-mini','high','Fresh','/tmp',${freshSeconds},'subagent',0,null),`,
        `('other-old-child','/tmp/other-old.jsonl','Other old lane','debugger','gpt-5.4-mini','high','OtherOld','/tmp',${oldSeconds},'subagent',0,null);`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "spawn one bounded child",
    }, {
      NATIVE_AGENT_POOL_STALE_OPEN_EDGE_RETENTION_HOURS: "36",
    });

    assert.match(output.hookSpecificOutput.additionalContext, /occupied=1\/6/);
    assert.equal(
      await sqliteReadonly(
        home,
        "select parent_thread_id,child_thread_id,status from thread_spawn_edges order by parent_thread_id,child_thread_id;",
      ),
      "parent1|fresh-child|open\nparent1|old-child|closed\nparent2|other-old-child|open",
    );
    assert.equal(await sqliteReadonly(home, "select archived from threads where id='old-child';"), "1");
  });
});

test("stale close request repairs current-parent open edge without waiting for repeated retries", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithArchiveColumns(home);
    const freshSeconds = Math.floor(Date.now() / 1000);
    const transcript = join(home, "parent.jsonl");
    await writeFile(
      transcript,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}',
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-old","arguments":"{\\"target\\":\\"old-close-child\\"}"}}',
      ].join("\n"),
    );
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','old-close-child','open'),('parent1','fresh-child','open');",
        "insert into threads(id,rollout_path,title,agent_role,model,reasoning_effort,agent_nickname,cwd,updated_at,thread_source,archived,archived_at)",
        `values ('old-close-child','/tmp/old.jsonl','Old lane','debugger','gpt-5.4-mini','high','Old','/tmp',${freshSeconds},'subagent',0,null),`,
        `('fresh-child','/tmp/fresh.jsonl','Fresh lane','debugger','gpt-5.4-mini','high','Fresh','/tmp',${freshSeconds},'subagent',0,null);`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn one bounded child",
    });

    assert.match(output.hookSpecificOutput.additionalContext, /occupied=1\/6/);
    assert.equal(
      await sqliteReadonly(
        home,
        "select child_thread_id,status from thread_spawn_edges order by child_thread_id;",
      ),
      "fresh-child|open\nold-close-child|closed",
    );
    assert.equal(await sqliteReadonly(home, "select archived from threads where id='old-close-child';"), "1");
  });
});

test("fresh close request grace period keeps current-parent edge open", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithArchiveColumns(home);
    const freshSeconds = Math.floor(Date.now() / 1000);
    const recentIso = new Date(Date.now() - 30 * 1000).toISOString();
    const transcript = join(home, "parent.jsonl");
    await writeFile(
      transcript,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}',
        `{"timestamp":"${recentIso}","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-recent","arguments":"{\\"target\\":\\"recent-close-child\\"}"}}`,
      ].join("\n"),
    );
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','recent-close-child','open');",
        "insert into threads(id,rollout_path,title,agent_role,model,reasoning_effort,agent_nickname,cwd,updated_at,thread_source,archived,archived_at)",
        `values ('recent-close-child','/tmp/recent.jsonl','Recent lane','debugger','gpt-5.4-mini','high','Recent','/tmp',${freshSeconds},'subagent',0,null);`,
      ].join(" "),
    );

    await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn one bounded child",
    });

    assert.equal(await sqliteReadonly(home, "select status from thread_spawn_edges where child_thread_id='recent-close-child';"), "open");
    assert.equal(await sqliteReadonly(home, "select archived from threads where id='recent-close-child';"), "0");
  });
});

test("transcript close after a cap hit does not override current-parent overfull native edges", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 8; index += 1) {
      const id = `child${index}`;
      const path = await writeFalseTaskCompleteTranscript(home, id);
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
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"default\\"}"}}',
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
    assert.match(context, /native_slots=slot_open=6, slot_terminal=0, slot_estimate=6\/6/);
    assert.match(context, /visible_unarchived=0/);
    assert.match(context, /ledger_lag=0/);
    assert.match(context, /db_open_edge_debt=8/);
    assert.doesNotMatch(context, /terminal_open=8/);
    assert.doesNotMatch(context, /native_global/);

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });
    assert.equal(spawnOutput.decision, "block");
    assert.match(spawnOutput.reason, /native_slots=slot_open=6, slot_terminal=0, slot_estimate=6\/6/);
    assert.match(spawnOutput.reason, /visible_unarchived=0/);
    assert.match(spawnOutput.reason, /ledger_lag=0/);
    assert.match(spawnOutput.reason, /db_open_edge_debt=8/);
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
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"default\\"}"}}',
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
        agent_type: "default",
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

test("transcript not-found close only decrements active fallback lanes", async () => {
  await withHome(async (home) => {
    const transcript = join(home, "parent-typo-close.jsonl");
    await writeFile(
      transcript,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}',
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"default\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn1","output":"{\\"agent_id\\":\\"child1\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:02.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn2","arguments":"{\\"agent_type\\":\\"default\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn2","output":"collab spawn failed: agent thread limit reached"}}',
        '{"timestamp":"2026-05-16T08:01:04.000Z","type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close1","arguments":"{\\"target\\":\\"typo-child\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"agent with id typo-child not found"}}',
      ].join("\n"),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      transcript_path: transcript,
      prompt: "spawn another agent",
    });
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /cap_hit_after_last_close=yes/);
    assert.match(context, /cap_hit_blocks_spawn=yes/);
    assert.match(context, /remaining_spawn_budget=0/);
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
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /native_slots=slot_open=6, slot_terminal=0/);
  });
});

test("task_complete outside terminal tail still counts as completed_not_closed", async () => {
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
    assert.match(context, /occupied=1\/6/);
    assert.match(context, /native_slots=slot_open=0, slot_terminal=1/);
    assert.match(context, /db_open_edge_debt=1/);
    assert.match(context, /LANES_COMPLETED_NOT_CLOSED=1/);
    assert.equal(
      await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status order by status;"),
      "open|1",
    );
  });
});

test("native authoritative state ignores stale transcript and never persists a spawn reservation", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");
    const transcript = join(home, "parent.jsonl");
    const lines = ['{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"parent1"}}'];
    for (let index = 1; index <= 6; index += 1) {
      lines.push(`{"timestamp":"2026-05-16T08:00:0${index}.000Z","type":"event_msg","payload":{"type":"collab_agent_spawn_end","sender_thread_id":"parent1","new_thread_id":"stale${index}"}}`);
    }
    await writeFile(transcript, lines.join("\n"));

    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    };
    const output = await runHook(home, input);
    const retry = await runHook(home, input);

    assert.notEqual(output?.decision, "block");
    assert.notEqual(retry?.decision, "block");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const reservations = Object.values(state.sessions["thread:parent1"].spawn_reservations);
    assert.equal(reservations.length, 0);
  });
});

test("blocks codex exec worker fallback from a shell tool", async () => {
  await withHome(async (home) => {
    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      session_id: "parent1",
      tool_input: {
        cmd: "codex exec --model gpt-5.6-terra 'reconstruct git state'",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /codex exec/);
    assert.match(output.reason, /outside the current parent\/session native pool/);
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
        '{"timestamp":"2026-05-16T08:01:00.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn-tail","arguments":"{\\"agent_type\\":\\"default\\"}"}}',
        '{"timestamp":"2026-05-16T08:01:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn-tail","output":"{\\"agent_id\\":\\"tail-child\\"}"}}',
      ].join("\n"),
    );

    const output = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "default",
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
        agent_type: "default",
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
        agent_type: "default",
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "low",
        message: "map files",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /state lock is unavailable/);
  });
});

test("post-spawn thread-limit failure emits close-candidate recovery directive", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 5; index += 1) {
      const id = `done${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','completed lane ${index}','debugger','gpt-5.4-mini','high','Done ${index}','/tmp',177907500${index});`,
      );
    }
    const activePath = join(home, "active.jsonl");
    await writeFile(
      activePath,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"active1"}}',
        '{"timestamp":"2026-05-16T08:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"still working"}}',
      ].join("\n"),
    );
    values.push("('parent1','active1','open')");
    await sqlite(
      home,
      `insert into threads values ('active1','${activePath}','active lane','critic','gpt-5.5','high','Active','/tmp',1779075010);`,
    );
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.4-mini",
        reasoning_effort: "high",
        message: "map FDR path",
      },
      tool_response: "collab spawn failed: agent thread limit reached",
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /SPAWN_AGENT_FAILED_POOL_FULL_RECOVERY_REQUIRED=true/);
    assert.match(context, /current_parent_occupied=6\/6/);
    assert.match(context, /completed_not_closed=5/);
    assert.match(context, /open_active=1/);
    assert.match(context, /CLOSE_CANDIDATES=done1,done2,done3,done4,done5/);
    assert.match(context, /close one or more listed completed_not_closed current-parent lane/);
    assert.match(context, /Do not switch to local-only execution solely because the pool is full/);
  });
});

test("zero budget guidance lists all completed close candidates even when terminal debt exceeds free slot cap", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 9; index += 1) {
      const id = `done${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','completed lane ${index}','debugger','gpt-5.4-mini','high','Done ${index}','/tmp',177907500${index});`,
      );
    }
    const activePath = join(home, "active.jsonl");
    await writeFile(
      activePath,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"active1"}}',
        '{"timestamp":"2026-05-16T08:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"still working"}}',
      ].join("\n"),
    );
    values.push("('parent1','active1','open')");
    await sqlite(
      home,
      `insert into threads values ('active1','${activePath}','active lane','critic','gpt-5.5','high','Active','/tmp',1779075010);`,
    );
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "need one more bounded child",
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(context, /close_needed_for_one=1/);
    assert.match(context, /close_needed_for_two=2/);
    assert.match(context, /close_needed_for_three=3/);
    assert.match(context, /CLOSE_BEFORE_SPAWN_REQUIRED=true/);
    assert.match(context, /CLOSE_CANDIDATES=done1,done2,done3,done4,done5,done6,done7,done8,done9/);
    assert.match(context, /completed_not_closed=9/);
    assert.match(context, /LANES_COMPLETED_NOT_CLOSED=9:/);
    assert.match(context, /close_target_id=done9/);
    assert.match(context, /close enough listed completed_not_closed current-parent lane\(s\)/);
    assert.doesNotMatch(context, /I cannot/);
  });
});

test("zero budget two-lane prompt treats completed lanes as close candidates not unknown agents", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `done${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','completed lane ${index}','debugger','gpt-5.4-mini','high','Done ${index}','/tmp',177907500${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "我会并行开两个子任务：一个追 process_pending，另一个追 GREEN 后为什么没有 entry。",
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(context, /requested_spawns=2/);
    assert.match(context, /close_needed_for_request=2/);
    assert.match(context, /COMPLETED_NOT_CLOSED_ARE_CLOSE_CANDIDATES=true/);
    assert.match(context, /Do not call these lanes unknown/);
    assert.match(context, /Do not describe listed completed_not_closed close candidates as unknown agents/);
  });
});

test("post-spawn pool-full recovery lists all completed close candidates beyond the cap slice", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 9; index += 1) {
      const id = `done${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','completed lane ${index}','debugger','gpt-5.4-mini','high','Done ${index}','/tmp',177907500${index});`,
      );
    }
    const activePath = join(home, "active.jsonl");
    await writeFile(
      activePath,
      [
        '{"timestamp":"2026-05-16T08:00:00.000Z","type":"session_meta","payload":{"id":"active1"}}',
        '{"timestamp":"2026-05-16T08:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"still working"}}',
      ].join("\n"),
    );
    values.push("('parent1','active1','open')");
    await sqlite(
      home,
      `insert into threads values ('active1','${activePath}','active lane','critic','gpt-5.5','high','Active','/tmp',1779075010);`,
    );
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
        model: "gpt-5.4-mini",
        reasoning_effort: "high",
        message: "map FDR path",
      },
      tool_response: "collab spawn failed: agent thread limit reached",
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /SPAWN_AGENT_FAILED_POOL_FULL_RECOVERY_REQUIRED=true/);
    assert.match(context, /completed_not_closed=9/);
    assert.match(context, /CLOSE_CANDIDATES=done1,done2,done3,done4,done5,done6,done7,done8,done9/);
    assert.match(context, /close one or more listed completed_not_closed current-parent lane/);
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

test("successful close_agent archives closed native child thread rows", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithArchiveColumns(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','open');",
        "insert into threads(id,rollout_path,title,agent_role,model,reasoning_effort,agent_nickname,cwd,updated_at,thread_source,archived,archived_at)",
        "values ('child1','/tmp/child1.jsonl','Archive Me','explorer','gpt-5.4-mini','medium','Scout','/tmp',1779074894,'subagent',0,null);",
      ].join(" "),
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "child1" },
      tool_response: { status: "closed" },
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "closed|1");
    assert.equal(await sqliteReadonly(home, "select archived, archived_at is not null from threads where id='child1';"), "1|1");
    assert.equal(await sqliteReadonly(home, "select agent_nickname from threads where id='child1';"), "archived-child1");
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

test("close_agent not found by short nickname does not repair current-parent lane", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','open');",
        "insert into threads values ('child1','/tmp/child1.jsonl','Trace Day0 forecast pipeline','explore','gpt-5.3-codex-spark','high','LaneAlpha','/tmp',1779074894);",
      ].join(" "),
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "LaneAlpha" },
      tool_response: "agent LaneAlpha not found",
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "open|1");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    assert.equal(state.sessions["thread:parent1"].unreachable_close_targets.LaneAlpha.count, 1);
  });
});

test("close_agent not found for unknown short target records tombstone without freeing capacity", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','open');",
        "insert into threads values ('child1','/tmp/child1.jsonl','Other lane','debugger','gpt-5.4-mini','high','Other','/tmp',1779074894);",
      ].join(" "),
    );

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "LaneAlpha" },
      tool_response: "agent LaneAlpha not found",
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "open|1");
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    assert.equal(state.sessions["thread:parent1"].unreachable_close_targets.LaneAlpha.count, 1);
    assert.equal(state.sessions["thread:parent1"].last_close_at ?? "", "");
  });
});

test("close_agent endpoint not found does not repair native edge", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(home, "insert into thread_spawn_edges values ('parent1','child1','open');");

    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "close_agent",
      session_id: "parent1",
      tool_input: { target: "child1" },
      tool_response: "transport error: endpoint not found",
    });

    assert.equal(await sqliteReadonly(home, "select status,count(*) from thread_spawn_edges group by status;"), "open|1");
  });
});

test("not-found close without native DB requires verified current-lane evidence", async () => {
  await withHome(async (home) => {
    await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
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
      tool_input: { target: "typo-child" },
      tool_response: "agent with id typo-child not found",
    });

    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    const session = state.sessions["thread:parent1"];
    assert.ok(session.last_cap_hit_at);
    assert.equal(session.last_close_at ?? "", "");
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
        agent_type: "default",
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
        agent_type: "default",
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

test("stale runtime cap hit does not override authoritative free native edge count", async () => {
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
        agent_type: "default",
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
    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=3/);
    assert.match(context, /batch_guarantee=false/);
    assert.match(context, /occupied=3\/6/);
    assert.match(context, /remaining_spawn_budget=3/);
    assert.match(context, /native_slots=slot_open=3/);
    assert.match(context, /slot_pressure_source=native_open_edges/);
    assert.match(context, /cap_hit_after_last_close=yes/);
    assert.match(context, /cap_hit_blocks_spawn=no/);

    const spawnOutput = await runHook(home, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "parent1",
      tool_input: {
        agent_type: "default",
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
        agent_type: "default",
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
        agent_type: "default",
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
        agent_type: "default",
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
        agent_type: "default",
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
        agent_type: "default",
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
    assert.match(output.hookSpecificOutput.additionalContext, /When observed_free is 0, do not call spawn_agent/);
    assert.match(output.hookSpecificOutput.additionalContext, /zero-budget snapshot/);
    assert.match(output.hookSpecificOutput.additionalContext, /ZERO_BUDGET_RECOVERY_REQUIRED=true/);
    assert.match(output.hookSpecificOutput.additionalContext, /Do not stop at saying the subagent pool is full/);
    assert.match(output.hookSpecificOutput.additionalContext, /choose one recovery action/);
    assert.match(output.hookSpecificOutput.additionalContext, /next hook\/PreToolUse capacity check/);
  });
});

test("session start positive budget guidance stays concise without model lecture", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const output = await runHook(home, {
      hook_event_name: "SessionStart",
      session_id: "parent1",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=6/);
    assert.match(context, /BATCH_SPAWN_GUARANTEE=false/);
    assert.match(context, /SPAWN_AGENT_DISABLED_THIS_TURN=false/);
    assert.match(context, /SUBAGENTS_AVAILABLE_FOR_VALUEFUL_PARALLEL_WORK=true/);
    assert.match(context, /do not say "I cannot\/no subagents"/);
    assert.match(context, /Do not report native subagent capacity as 0/);
    assert.match(context, /NATIVE_SPAWN_SHAPE_CONTRACT=true/);
    assert.match(context, /make model selection explicit/);
    assert.doesNotMatch(context, /SUBAGENT_MODEL_SELECTION_REQUIRED=true/);
    assert.doesNotMatch(context, /task_contract=\{output,risk,state_depth/);
    assert.doesNotMatch(context, /ZERO_BUDGET_RECOVERY_REQUIRED=true/);
    assert.doesNotMatch(context, /When observed_free is 0, do not call spawn_agent/);
  });
});

test("unarchived current-parent child threads count even when edges are missing", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const threadValues = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `visible${index}`;
      threadValues.push(
        `('${id}','/tmp/${id}.jsonl','visible ${index}','default','gpt-5.4-mini','high','Visible ${index}','/tmp',${nowSeconds},'${subagentSource("parent1", `Visible ${index}`)}','subagent',0,null)`,
      );
    }
    await sqlite(
      home,
      [
        `insert into threads values ${threadValues.join(",")};`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "start one more critic",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(context, /occupied=6\/6/);
    assert.match(context, /visible_unarchived=6/);
    assert.match(context, /LANES_OPEN=6/);
  });
});

test("unarchived child threads with closed native edges do not consume current-parent capacity", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const threadValues = [];
    const edgeValues = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `closed_visible${index}`;
      threadValues.push(
        `('${id}','/tmp/${id}.jsonl','closed visible ${index}','default','gpt-5.4-mini','high','Closed ${index}','/tmp',${nowSeconds},'${subagentSource("parent1", `Closed ${index}`)}','subagent',0,null)`,
      );
      edgeValues.push(`('parent1','${id}','closed')`);
    }
    await sqlite(
      home,
      [
        `insert into threads values ${threadValues.join(",")};`,
        `insert into thread_spawn_edges values ${edgeValues.join(",")};`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "start one more critic",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=6/);
    assert.match(context, /occupied=0\/6/);
    assert.match(context, /native_slots=slot_open=0, slot_terminal=0, slot_estimate=0\/6/);
    assert.match(context, /visible_unarchived=0/);
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where coalesce(archived,0)=1;"),
      "6",
    );
  });
});

test("stale orphan visible child threads are archived before admission", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const oldSeconds = Math.floor((Date.now() - (48 * 60 * 60 * 1000)) / 1000);
    const threadValues = [];
    for (let index = 1; index <= 19; index += 1) {
      const id = `orphan_visible${index}`;
      threadValues.push(
        `('${id}','/tmp/${id}.jsonl','orphan visible ${index}','default','gpt-5.4-mini','high','Orphan ${index}','/tmp',${oldSeconds},'${subagentSource("parent1", `Orphan ${index}`)}','subagent',0,null)`,
      );
    }
    await sqlite(home, `insert into threads values ${threadValues.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "start one more critic",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=6/);
    assert.match(context, /visible_unarchived=0/);
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where coalesce(archived,0)=0;"),
      "0",
    );
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where coalesce(archived,0)=1;"),
      "19",
    );
  });
});

test("current-parent closed edges archive visible child threads before admission", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const edgeValues = [];
    const threadValues = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `closed_visible${index}`;
      edgeValues.push(`('parent1','${id}','closed')`);
      threadValues.push(
        `('${id}','/tmp/${id}.jsonl','closed visible ${index}','default','gpt-5.4-mini','high','Closed ${index}','/tmp',${nowSeconds},'${subagentSource("parent1", `Closed ${index}`)}','subagent',0,null)`,
      );
    }
    await sqlite(
      home,
      [
        `insert into thread_spawn_edges values ${edgeValues.join(",")};`,
        `insert into threads values ${threadValues.join(",")};`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "start one more critic",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=6/);
    assert.match(context, /visible_unarchived=0/);
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where coalesce(archived,0)=0;"),
      "0",
    );
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where agent_nickname like 'Closed%';"),
      "0",
    );
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where json_extract(source,'$.subagent.thread_spawn.agent_nickname') like 'Closed%';"),
      "0",
    );
  });
});

test("current-parent closed edge archiving tolerates missing archived_at column", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveNoArchivedAt(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','closed_visible','closed');",
        "insert into threads values",
        `('closed_visible','/tmp/closed.jsonl','closed visible','default','gpt-5.4-mini','high','Closed','/tmp',${nowSeconds},'${subagentSource("parent1", "Closed")}','subagent',0);`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "start one more critic",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /^SPAWN_AGENT_OBSERVED_FREE=6/);
    assert.match(context, /visible_unarchived=0/);
    assert.equal(
      await sqliteReadonly(home, "select count(*) from threads where coalesce(archived,0)=0;"),
      "0",
    );
  });
});

test("post-compact sanitizes closed archived lanes from visible subagents context", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const transcript = join(home, "parent.jsonl");
    const closedId = "019efe2f-583a-71b2-a372-b01c567b376f";
    const openId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    await writeFile(
      transcript,
      [
        JSON.stringify({
          timestamp: "2026-06-27T02:00:00.000Z",
          type: "session_meta",
          payload: { id: "parent1" },
        }),
        JSON.stringify({
          timestamp: "2026-06-27T02:01:00.000Z",
          type: "compacted",
          payload: {
            replacement_history: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `<environment_context>\n  <subagents>\n    - ${closedId}: archived-019efe2f (closed archived stale)\n    - ${openId}: Averroes the 2nd\n  </subagents>\n</environment_context>`,
                  },
                ],
              },
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: `The old close loop kept targeting archived-019efe2f and ${closedId}. Keep ${openId} active.`,
                  },
                ],
              },
            ],
          },
        }),
      ].join("\n"),
    );
    await sqlite(
      home,
      `insert into thread_spawn_edges values ('parent1','${closedId}','closed'),('parent1','${openId}','open');`,
    );
    await sqlite(
      home,
      "insert into threads values "
        + `('${closedId}','/tmp/closed.jsonl','archived stale child','explore','gpt-5.3-codex-spark','high','archived-019efe2f','/repo',1779074000,'${subagentSource("parent1", "archived-019efe2f")}','subagent',1,1779074001),`
        + `('${openId}','/tmp/open.jsonl','Current debugger','debugger','gpt-5.4-mini','high','Averroes','/repo',1779076002,'${subagentSource("parent1", "Averroes")}','subagent',0,0);`,
    );

    await runHook(home, {
      hook_event_name: "PostCompact",
      transcript_path: transcript,
    });

    const text = await readFile(transcript, "utf-8");
    assert.doesNotMatch(text, new RegExp(closedId));
    assert.doesNotMatch(text, /archived-019efe2f/);
    assert.match(text, new RegExp(openId));
  });
});

test("post-compact sanitizes mentioned archived child ids from another parent without counting them", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const transcript = join(home, "parent.jsonl");
    const otherClosedId = "019efe2f-583a-71b2-a372-b01c567b376f";
    const currentOpenId = "019f0608-4a43-70b1-bdd3-26e3ab0d5cf5";
    await writeFile(
      transcript,
      [
        JSON.stringify({
          timestamp: "2026-06-27T02:00:00.000Z",
          type: "session_meta",
          payload: { id: "current-parent" },
        }),
        JSON.stringify({
          timestamp: "2026-06-27T02:01:00.000Z",
          type: "compacted",
          payload: {
            replacement_history: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: `Old context kept mentioning ${otherClosedId} and archived-019efe2f, while current ${currentOpenId} remains open.`,
                  },
                ],
              },
            ],
          },
        }),
      ].join("\n"),
    );
    await sqlite(
      home,
      `insert into thread_spawn_edges values ('current-parent','${currentOpenId}','open'),('other-parent','${otherClosedId}','closed');`,
    );
    await sqlite(
      home,
      "insert into threads values "
        + `('${otherClosedId}','/tmp/closed.jsonl','archived stale child','explore','gpt-5.3-codex-spark','high','archived-019efe2f','/repo',1779074000,'${subagentSource("other-parent", "archived-019efe2f")}','subagent',1,1779074001),`
        + `('${currentOpenId}','/tmp/open.jsonl','Current debugger','debugger','gpt-5.4-mini','high','Averroes','/repo',1779076002,'${subagentSource("current-parent", "Averroes")}','subagent',0,0);`,
    );

    await runHook(home, {
      hook_event_name: "PostCompact",
      transcript_path: transcript,
    });

    const text = await readFile(transcript, "utf-8");
    assert.doesNotMatch(text, new RegExp(otherClosedId));
    assert.doesNotMatch(text, /archived-019efe2f/);
    assert.match(text, new RegExp(currentOpenId));
    assert.equal(
      await sqliteReadonly(home, "select parent_thread_id,status,count(*) from thread_spawn_edges where parent_thread_id='current-parent' group by parent_thread_id,status order by parent_thread_id,status;"),
      "current-parent|open|1",
    );
  });
});

test("completed visible child lanes are close candidates and not duplicated as open lanes", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const donePath = await writeTaskCompleteTranscript(home, "done1");
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','active1','open'),('parent1','done1','open');",
        "insert into threads values",
        `('active1','/tmp/active1.jsonl','active lane','default','gpt-5.4-mini','high','Active','/tmp',${nowSeconds},'${subagentSource("parent1", "Active")}','subagent',0,null),`,
        `('done1','${donePath.replace(/'/g, "''")}','done lane','default','gpt-5.4-mini','high','Done','/tmp',${nowSeconds},'${subagentSource("parent1", "Done")}','subagent',0,null);`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "SessionStart",
      session_id: "parent1",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /occupied=2\/6/);
    assert.match(context, /slot_open=1, slot_terminal=1, slot_estimate=2\/6/);
    assert.match(context, /completed_not_closed=1/);
    assert.match(context, /LANES_OPEN=1:/);
    assert.match(context, /LANES_COMPLETED_NOT_CLOSED=1:/);
    const openSection = context.slice(
      context.indexOf("LANES_OPEN=1:"),
      context.indexOf("LANES_COMPLETED_NOT_CLOSED=1:"),
    );
    assert.doesNotMatch(openSection, /Done/);
  });
});

test("open native edge unarchives restored child thread before admission", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','restored1','open');",
        "insert into threads values",
        `('restored1','/tmp/restored1.jsonl','restored lane','default','gpt-5.4-mini','high','Restored','/tmp',${nowSeconds},'${subagentSource("parent1", "Restored")}','subagent',1,${nowSeconds});`,
      ].join(" "),
    );

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "check capacity after restoring lane",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /occupied=1\/6/);
    assert.match(context, /visible_unarchived=1/);
    assert.match(context, /LANES_OPEN=1:/);
    assert.equal(
      await sqliteReadonly(home, "select archived, archived_at is null from threads where id='restored1';"),
      "0|1",
    );
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
    assert.match(context, /close listed current-parent lane\(s\)/);
    assert.match(context, /Do not convert pool-full into a silent local-only plan/);
    assert.match(context, /send_input and wait_agent do not increase capacity/);
    assert.match(context, /If close_agent succeeds, re-check capacity before any spawn/);
    assert.match(context, /older zero-budget snapshot is no longer authoritative/);
    assert.doesNotMatch(context, /or continue locally/);
  });
});

test("post-tool non-agent capacity refresh restores close-before-spawn guidance during long turns", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `done${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','completed lane ${index}','debugger','gpt-5.4-mini','high','Done ${index}','/tmp',177907500${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "codegraph_context",
      session_id: "parent1",
      tool_input: { projectPath: "/tmp/repo", task: "map current code" },
      tool_response: "mapped source anchors",
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /^SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(context, /CLOSE_BEFORE_SPAWN_REQUIRED=true/);
    assert.match(context, /CLOSE_CANDIDATES=done1,done2,done3,done4,done5,done6/);
    assert.match(context, /Close enough listed completed_not_closed current-parent lane\(s\) before any spawn_agent call/);
  });
});

test("post-tool non-agent capacity refresh stays quiet without pool pressure", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "codegraph_context",
      session_id: "parent1",
      tool_input: { projectPath: "/tmp/repo", task: "map current code" },
      tool_response: "mapped source anchors",
    });

    assert.equal(output, null);
  });
});

test("post-tool tool_search native schema output is corrected before spawn", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const values = [];
    for (let index = 1; index <= 6; index += 1) {
      const id = `done${index}`;
      const path = await writeTaskCompleteTranscript(home, id);
      values.push(`('parent1','${id}','open')`);
      await sqlite(
        home,
        `insert into threads values ('${id}','${path}','completed lane ${index}','debugger','gpt-5.4-mini','high','Done ${index}','/tmp',177907500${index});`,
      );
    }
    await sqlite(home, `insert into thread_spawn_edges values ${values.join(",")};`);

    const output = await runHook(home, {
      hook_event_name: "PostToolUse",
      tool_name: "tool_search_tool",
      session_id: "parent1",
      tool_input: { query: "spawn_agent native subagent" },
      tool_response: {
        type: "tool_search_output",
        tools: [
          {
            name: "multi_agent_v1.spawn_agent",
            description:
              "Available model overrides (optional; inherited parent model is preferred). Spawned agents inherit your current model by default. Omit `model` to use that preferred model.",
          },
        ],
      },
    });

    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /TOOL_SEARCH_NATIVE_AGENT_SCHEMA_CORRECTION_REQUIRED=true/);
    assert.match(context, /generic native subagent metadata/);
    assert.match(context, /model optional/);
    assert.match(context, /inherited parent model is preferred/);
    assert.match(context, /TOOL_SEARCH_NATIVE_AGENT_SCHEMA_IS_NOT_AUTHORITY=true/);
    assert.match(context, /Tool-schema text saying model is optional\/inherited is unsafe/);
    assert.match(context, /SPAWN_AGENT_DISABLED_THIS_TURN=true/);
    assert.match(context, /CLOSE_BEFORE_SPAWN_REQUIRED=true/);
    assert.match(context, /CLOSE_CANDIDATES=done1,done2,done3,done4,done5,done6/);
    assert.match(context, /Every non-fork spawn_agent call/);
  });
});

test("periodic maintenance prunes only expired closed native edges", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldSeconds = nowSeconds - 8 * 24 * 60 * 60;
    const recentSeconds = nowSeconds - 60 * 60;
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values",
        "('parent1','old_closed','closed'),",
        "('parent1','recent_closed','closed'),",
        "('parent1','old_open','open'),",
        "('parent1','orphan_closed','closed');",
        "insert into threads values",
        `('old_closed','/tmp/old.jsonl','old','default','gpt-5.4-mini','high','Old','/tmp',${oldSeconds},'subagent',0,${oldSeconds}),`,
        `('recent_closed','/tmp/recent.jsonl','recent','default','gpt-5.4-mini','high','Recent','/tmp',${recentSeconds},'subagent',0,${recentSeconds}),`,
        `('old_open','/tmp/open.jsonl','open','default','gpt-5.4-mini','high','Open','/tmp',${oldSeconds},'subagent',0,null);`,
      ].join(" "),
    );

    await runHook(home, {
      hook_event_name: "SessionStart",
      session_id: "parent1",
    });

    assert.equal(
      await sqliteReadonly(home, "select child_thread_id||':'||status from thread_spawn_edges order by child_thread_id;"),
      ["old_open:open", "recent_closed:closed"].join("\n"),
    );
    assert.equal(
      await sqliteReadonly(home, "select id||':'||coalesce(archived,0) from threads order by id;"),
      ["old_closed:1", "old_open:0", "recent_closed:1"].join("\n"),
    );
    const state = JSON.parse(await readFile(join(home, "state", "native-agent-pool-advisor.json"), "utf-8"));
    assert.equal(state.last_native_edge_closed_archive_count, 2);
    assert.ok(state.last_native_edge_closed_archive_at);
    assert.equal(state.last_native_edge_closed_prune_count, 2);
    assert.ok(state.last_native_edge_closed_prune_at);
  });
});

test("negative spawn intent suppresses prompt-triggered model lecture", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const output = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "Review this locally; do not spawn agents.",
    });

    assert.equal(output, null);
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
    assert.match(context, /NATIVE_SUBAGENT_USER_AUTHORIZATION_NOT_REQUIRED=true/);
    assert.match(context, /LOCAL_NATIVE_AGENT_POLICY_OVERRIDES_TOOL_SCHEMA=true/);
    assert.match(context, /TOOL_SEARCH_NATIVE_AGENT_SCHEMA_IS_NOT_AUTHORITY=true/);
    assert.match(context, /bounded native child-agent delegation does not require a separate user request/);
    assert.doesNotMatch(context, /subagents require explicit user request/);
    assert.match(context, /SUBAGENT_MODEL_DECISION_REQUIRED=true/);
    assert.match(context, /FORK_CONTEXT_HARD_RULE=true/);
    assert.match(context, /if fork_context=true, omit agent_type and model/);
    assert.match(context, /full-history forks cannot override role or model/i);
    assert.match(context, /task_contract=\{output,risk,state_depth,context_size,edit_permission,final_authority,output_cap,stop_condition\}/);
    assert.match(context, /Every non-fork spawn_agent call/);
    assert.match(context, /default to model=\"gpt-5\.6-terra\"/);
    assert.match(context, /model=\"gpt-5\.6-luna\"/);
    assert.match(context, /model=\"gpt-5\.6-terra\"/);
    assert.match(context, /model=\"gpt-5\.6-sol\"/);
    assert.match(context, /bounded locating/);
    assert.match(context, /Luna must not own durable conclusions/);
    assert.match(context, /tracing, diagnosis, synthesis/);
    assert.match(context, /frontier judgment/);
    assert.match(context, /Luna search contract/);
    assert.match(context, /Luna must not own durable conclusions or broad synthesis/);
    assert.match(context, /rg --max-count\/--max-filesize/);
    assert.match(context, /runtime 'agent type is currently not available'/);
    assert.match(context, /If you cannot state the child output cap, stop condition, and bounded search shape, do not use Luna/);
    assert.match(context, /multi-spawn tool call must fit the current PreToolUse observed_free/);
    assert.match(context, /large-context repos, first make a local module\/file map/);
    assert.match(context, /This judgment step is mandatory/);
    assert.match(context, /inheritance can silently select the wrong 5\.6 family member/);
    assert.match(context, /must not override positive-capacity guidance/);
    assert.match(context, /use or reuse native subagents deliberately/);
  });
});

test("post-compact emits compact native spawn shape contract", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const output = await runHook(home, {
      hook_event_name: "PostCompact",
      session_id: "parent1",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /NATIVE_SPAWN_SHAPE_CONTRACT=true/);
    assert.match(context, /NATIVE_SUBAGENT_USER_AUTHORIZATION_NOT_REQUIRED=true/);
    assert.match(context, /LOCAL_NATIVE_AGENT_POLICY_OVERRIDES_TOOL_SCHEMA=true/);
    assert.match(context, /TOOL_SEARCH_NATIVE_AGENT_SCHEMA_IS_NOT_AUTHORITY=true/);
    assert.match(context, /does not require a separate explicit user request/);
    assert.doesNotMatch(context, /subagents require explicit user request/);
    assert.doesNotMatch(context, /inherited model is preferred/);
    assert.match(context, /FORK_CONTEXT_HARD_RULE=true/);
    assert.match(context, /fork_context=true, omit agent_type and model/);
    assert.match(context, /Native agent_type availability belongs to Codex runtime/);
    assert.match(context, /If a special native agent_type is unavailable/);
    assert.match(context, /model is optional\/inherited is unsafe/);
    assert.match(context, /gpt-5\.6-luna/);
    assert.match(context, /gpt-5\.6-terra/);
    assert.match(context, /gpt-5\.6-sol/);
    assert.match(context, /Luna compaction rule/);
    assert.match(context, /bounded search shape plus output cap\/stop condition/);
  });
});

test("pre-compact emits remote compact runtime risk guidance", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const output = await runHook(home, {
      hook_event_name: "PreCompact",
      session_id: "parent1",
    });
    const context = output.hookSpecificOutput.additionalContext;

    assert.match(context, /REMOTE_COMPACT_LIMIT_RISK=true/);
    assert.match(context, /runtime compact boundary/);
    assert.match(context, /not a single-model or model-selection-only issue/);
    assert.match(context, /cannot trim the compact payload/);
    assert.match(context, /gpt-5\.6-luna is the bounded locator lane/);
    assert.match(context, /gpt-5\.6-terra is the standard worker/);
    assert.match(context, /gpt-5\.6-sol is the frontier judgment lane/);
    assert.match(context, /If compact fails with context-window exhaustion/);
    assert.match(context, /short handoff\/new thread/);
  });
});

test("generic user prompts get periodic compact spawn shape reminder", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);

    const first = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "Continue implementation.",
    });
    assert.match(first.hookSpecificOutput.additionalContext, /NATIVE_SPAWN_SHAPE_CONTRACT=true/);
    assert.match(first.hookSpecificOutput.additionalContext, /TOOL_SEARCH_NATIVE_AGENT_SCHEMA_IS_NOT_AUTHORITY=true/);
    assert.match(first.hookSpecificOutput.additionalContext, /FORK_CONTEXT_HARD_RULE=true/);
    assert.match(first.hookSpecificOutput.additionalContext, /Native agent_type availability belongs to Codex runtime/);

    const second = await runHook(home, {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent1",
      prompt: "Continue implementation again.",
    });
    assert.equal(second, null);
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

test("child session spawn denial takes precedence over model retry guidance", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const transcript = join(home, "child-spawn.jsonl");
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
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      session_id: "child1",
      transcript_path: transcript,
      tool_input: {
        agent_type: "default",
        message: "child should not spawn",
      },
    });

    assert.equal(output.decision, "block");
    assert.match(output.reason, /Nested native spawn is blocked/);
    assert.doesNotMatch(output.reason, /Retry only after making model-selection judgment explicit/);
    assert.doesNotMatch(output.reason, /Subagent spawn is blocked until tool input includes an explicit model/);
  });
});

test("installer is idempotent for existing hooks.json", async () => {
  await withHome(async (home) => {
    await runScript(installPath, home);
    await runScript(installPath, home);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    for (const eventName of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact"]) {
      const count = config.hooks[eventName]
        .flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.command.includes("native-agent-pool-advisor.mjs")).length;
      assert.equal(count, 1, eventName);
    }
    const sessionStartEntry = config.hooks.SessionStart.find((entry) => {
      return (entry.hooks ?? []).some((hook) => hook.command.includes("native-agent-pool-advisor.mjs"));
    });
    assert.equal(sessionStartEntry.matcher, "startup|resume|clear");
    assert.equal(await pathExists(join(home, "hooks", "native-agent-pool-global-state-watch.mjs")), true);
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
              matcher: "startup|resume|clear",
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
          PreCompact: [
            { hooks: [{ type: "command", command: `node "${join(home, "hooks", "native-agent-pool-advisor.mjs")}"` }] },
          ],
          PostCompact: [
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
    assert.equal(advisorEntries[0].matcher, "startup|resume|clear");
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
    assert.equal(doctor.checks.registrations.PreCompact, 1);
    assert.equal(doctor.checks.registrations.PostCompact, 1);
    assert.equal(doctor.checks.global_state_watcher_exists, true);
    assert.equal(doctor.checks.global_state_watcher_matches_repo, true);
    assert.equal(doctor.runtime_capabilities.registration_verified_only, true);
    assert.equal(doctor.runtime_capabilities.native_spawn_pre_tool_use_hard_block, "not_documented");

    const dryRun = JSON.parse((await runScript(uninstallPath, home, ["--dry-run"])).stdout);
    assert.equal(dryRun.removed_registrations, 6);

    const removed = JSON.parse((await runScript(uninstallPath, home)).stdout);
    assert.equal(removed.removed_registrations, 6);
    assert.equal(removed.watcher_file_removed, true);
    const config = JSON.parse(await readFile(join(home, "hooks.json"), "utf-8"));
    for (const eventName of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact"]) {
      const entries = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
      const count = entries
        .flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.command.includes("native-agent-pool-advisor.mjs")).length;
      assert.equal(count, 0, eventName);
    }
  });
});

test("doctor ignores unsupported models on non-subagent threads", async () => {
  await withHome(async (home) => {
    await sqlite(
      home,
      [
        "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
        "create table threads(",
        "id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,",
        "source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,",
        "sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,",
        "has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,",
        "git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT NOT NULL DEFAULT '',",
        "first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled',",
        "model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,",
        "thread_source TEXT, preview TEXT NOT NULL DEFAULT ''",
        ");",
        "insert into threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,archived,agent_role,model,reasoning_effort,thread_source)",
        "values",
        "('old-user','/tmp/old-user.jsonl',1774945000,1774945934,'vscode','openai','/tmp','old user thread','danger-full-access','never',0,'','gpt-5.1-codex-mini','medium','user'),",
        "('child1','/tmp/child1.jsonl',1779075000,1779076000,'{}','openai','/tmp','valid child','danger-full-access','never',0,'debugger','gpt-5.6-terra','medium','subagent');",
        "insert into thread_spawn_edges values ('parent1','child1','open');",
      ].join(" "),
    );
    await runScript(installPath, home);

    const doctor = JSON.parse((await runScript(doctorPath, home)).stdout);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.checks.unsupported_unarchived_thread_models_count, 0);
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
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"E2E hook test only\\"}"}}',
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

test("live-check treats blank model as missing model bypass evidence", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Blank Model','explorer','gpt-5.5','low','Mencius','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-blank-model.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"   \\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"blank model test\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Mencius\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_spawn_missing_model_bypassed_advisor");
    assert.equal(output.spawn_calls[0].has_model, false);
  });
});

test("live-check allows boolean fork_context spawn without explicit model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Fork Model','explorer','gpt-5.5','low','Mencius','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-fork-model.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"fork_context\\":true,\\"reasoning_effort\\":\\"medium\\",\\"message\\":\\"exact history fork\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Mencius\\"}"}}',
      ].join("\n"),
    );

    const output = JSON.parse((await runScript(liveCheckPath, home, [
      "--transcript", transcript,
      "--allow-missing-guidance",
    ])).stdout);
    assert.equal(output.ok, true);
    assert.equal(output.spawn_calls[0].fork_context, true);
    assert.equal(output.spawn_calls[0].has_model, false);
  });
});

test("live-check detects explorer role using explicit frontier model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Frontier Explorer','explorer','gpt-5.6-sol','high','Hubble','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-explorer-frontier.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"explorer\\",\\"model\\":\\"gpt-5.6-sol\\",\\"reasoning_effort\\":\\"high\\",\\"message\\":\\"Architecture critic lane using explicit frontier model.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Hubble\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_explorer_frontier_model_violation");
    const check = output.checks.find((item) => item.name === "no_explorer_frontier_spawn_created");
    assert.equal(check.status, "fail");
    assert.match(check.evidence, /tool_role=explorer/);
    assert.match(check.evidence, /native_model=gpt-5\.6-sol/);
    assert.equal(output.spawn_calls[0].explorer_frontier_violation, true);
  });
});

test("live-check detects fork_context role conflict that created a child", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Fork role conflict','debugger','gpt-5.4-mini','high','Hubble','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-fork-role-conflict.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"debugger\\",\\"fork_context\\":true,\\"message\\":\\"debug current live state\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Hubble\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_fork_context_role_conflict_bypassed_advisor");
    assert.equal(output.checks.find((item) => item.name === "no_fork_context_role_spawn_created").status, "fail");
    assert.equal(output.spawn_calls[0].fork_context_role_conflict, true);
  });
});

test("live-check fails unsafe tool_search native schema before spawn without correction", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Missing model child','debugger','gpt-5.4-mini','high','Parfit','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-tool-search-schema.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"tool_search_output","tools":[{"type":"namespace","name":"multi_agent_v1","description":"Tools for spawning and managing sub-agents.","tools":[{"type":"function","name":"spawn_agent","description":"Available model overrides (optional; inherited parent model is preferred). Spawned agents inherit your current model by default. Omit `model` to use that preferred default."}]}]}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"debugger\\",\\"fork_context\\":false,\\"message\\":\\"debug current live state\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Parfit\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    const check = output.checks.find((item) => item.name === "unsafe_tool_search_schema_corrected_before_spawn");
    assert.equal(check.status, "fail");
    assert.match(check.evidence, /line 2 -> first spawn line 3/);
  });
});

test("live-check supports configurable forbidden explorer models", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Mini Explorer','explorer','gpt-5.4-mini','medium','Scout','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-forbid-mini.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"explorer\\",\\"model\\":\\"gpt-5.4-mini\\",\\"reasoning_effort\\":\\"medium\\",\\"message\\":\\"Mini explorer lane.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Scout\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, [
        "--transcript", transcript,
        "--allow-missing-guidance",
        "--forbid-explorer-model", "gpt-5.4-mini",
      ]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_explorer_frontier_model_violation");
    assert.equal(output.spawn_calls[0].explorer_frontier_violation, true);
  });
});

test("live-check allows special native agent_type attempts by default", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Mini Researcher','researcher','gpt-5.4-mini','high','Feynman','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-unsupported-agent-type.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"researcher\\",\\"model\\":\\"gpt-5.4-mini\\",\\"reasoning_effort\\":\\"high\\",\\"message\\":\\"External reference research.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Feynman\\"}"}}',
      ].join("\n"),
    );

    const { stdout } = await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    const output = JSON.parse(stdout);
    assert.equal(output.verdict, "live_check_passed_without_transcript_guidance");
    const check = output.checks.find((item) => item.name === "no_unsupported_native_agent_type_attempted");
    assert.equal(check.status, "pass");
    assert.match(check.evidence, /audit disabled/);
    assert.equal(output.spawn_calls[0].unsupported_agent_type, false);
  });
});

test("live-check rejects a successful special native agent_type without an explicit model", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Code Review','code-reviewer','gpt-5.5','high','Anscombe','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-code-reviewer-fixed-model.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"code-reviewer\\",\\"message\\":\\"Review the diff.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Anscombe\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_spawn_missing_model_bypassed_advisor");
    assert.equal(output.checks.find((item) => item.name === "no_missing_model_spawn_created").status, "fail");
    assert.equal(output.spawn_calls[0].has_model, false);
    assert.equal(output.spawn_calls[0].unsupported_agent_type, false);
  });
});

test("live-check reports runtime unavailable special agent_type as a spawn failure", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const transcript = join(home, "parent-unsupported-agent-type-failed.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"researcher\\",\\"fork_context\\":false,\\"message\\":\\"External reference research.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"agent type is currently not available"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "live_check_failed");
    const check = output.checks.find((item) => item.name === "no_unsupported_native_agent_type_attempted");
    assert.equal(check.status, "pass");
    assert.match(check.evidence, /audit disabled/);
    assert.equal(output.checks.find((item) => item.name === "no_spawn_failures").status, "fail");
    assert.equal(output.spawn_calls[0].created_agent_id, null);
    assert.equal(output.spawn_calls[0].unsupported_agent_type, false);
  });
});

test("live-check detects unsupported probe followed by missing-model default fallback", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','open');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Fallback Critic','default','gpt-5.5','high','Gibbs','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-unsupported-then-default-missing-model.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"critic\\",\\"fork_context\\":false,\\"message\\":\\"Codex-only critic review.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"agent type is currently not available"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call2","arguments":"{\\"agent_type\\":\\"code-reviewer\\",\\"fork_context\\":false,\\"message\\":\\"Codex-only critic-equivalent review.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call2","output":"agent type is currently not available"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call3","arguments":"{\\"agent_type\\":\\"default\\",\\"fork_context\\":false,\\"message\\":\\"Codex-only critic review.\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call3","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Gibbs\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_spawn_missing_model_bypassed_advisor");
    assert.equal(output.checks.find((item) => item.name === "no_unsupported_native_agent_type_attempted").status, "pass");
    assert.match(output.checks.find((item) => item.name === "no_unsupported_native_agent_type_attempted").evidence, /audit disabled/);
    assert.equal(output.checks.find((item) => item.name === "no_missing_model_spawn_created").status, "fail");
    assert.equal(output.checks.find((item) => item.name === "no_spawn_failures").status, "fail");
  });
});

test("live-check detects native model mismatch for explicit-model spawn", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      "insert into thread_spawn_edges values ('parent1','child1','closed');"
        + "insert into threads values ('child1','/tmp/child.jsonl','Mismatch','explorer','gpt-5.5','low','Mencius','/tmp',1779074894);",
    );
    const transcript = join(home, "parent-model-mismatch.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"explicit model test\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Mencius\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.verdict, "native_spawn_model_mismatch");
    const check = output.checks.find((item) => item.name === "tool_model_matches_native");
    assert.equal(check.status, "fail");
    assert.match(check.evidence, /tool_model=gpt-5\.3-codex-spark/);
    assert.match(check.evidence, /native_model=gpt-5\.5/);
  });
});

test("live-check reports native DB unavailable instead of model mismatch", async () => {
  await withHome(async (home) => {
    const transcript = join(home, "parent-db-missing.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.5\\",\\"reasoning_effort\\":\\"high\\",\\"message\\":\\"critic\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Critic\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, [
        "--transcript", transcript,
        "--state-db", join(home, "missing-state.sqlite"),
        "--allow-missing-guidance",
      ]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_db_unavailable");
    assert.equal(output.checks.find((item) => item.name === "tool_model_matches_native").status, "pass");
  });
});

test("live-check reports missing native edge separately from model mismatch", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const transcript = join(home, "parent-edge-missing.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.5\\",\\"reasoning_effort\\":\\"high\\",\\"message\\":\\"critic\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"{\\"agent_id\\":\\"child1\\",\\"nickname\\":\\"Critic\\"}"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.verdict, "native_spawn_edge_missing");
    assert.equal(output.checks.find((item) => item.name === "tool_model_matches_native").status, "pass");
    const edgeCheck = output.checks.find((item) => item.name === "native_edges_observed_for_successful_spawns");
    assert.equal(edgeCheck.status, "fail");
    assert.match(edgeCheck.evidence, /child1/);
  });
});

test("live-check records same-response native spawn batches and fails runtime spawn failures", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    const transcript = join(home, "parent-batch.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"one\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call2","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.4-mini\\",\\"reasoning_effort\\":\\"medium\\",\\"message\\":\\"two\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"collab spawn failed: agent thread limit reached"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call2","output":"collab spawn failed: agent thread limit reached"}}',
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
    assert.deepEqual(output.spawn_batches, [[2, 3]]);
    assert.equal(output.checks.find((check) => check.name === "no_spawn_failures").status, "fail");
    assert.equal(output.spawn_calls[0].output_failed, true);
    assert.equal(output.spawn_calls[1].output_failed, true);
  });
});

test("live-check parses nested multi-tool spawn calls", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','closed'),('parent1','child2','closed');",
        "insert into threads values ('child1','/tmp/child1.jsonl','Nested One','explorer','gpt-5.3-codex-spark','low','One','/tmp',1779075987);",
        "insert into threads values ('child2','/tmp/child2.jsonl','Nested Two','explorer','gpt-5.4-mini','medium','Two','/tmp',1779076009);",
      ].join(""),
    );
    const transcript = join(home, "parent-nested.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"multi_tool_use.parallel","call_id":"wrap1","arguments":"{\\"tool_uses\\":[{\\"recipient_name\\":\\"functions.spawn_agent\\",\\"parameters\\":{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"one\\"}},{\\"recipient_name\\":\\"functions.spawn_agent\\",\\"parameters\\":{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.4-mini\\",\\"reasoning_effort\\":\\"medium\\",\\"message\\":\\"two\\"}}]}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"wrap1","output":"[{\\"agent_id\\":\\"child1\\"},{\\"agent_id\\":\\"child2\\"}]"}}',
      ].join("\n"),
    );

    const result = JSON.parse((await runScript(liveCheckPath, home, [
      "--transcript", transcript,
      "--expect-model", "gpt-5.3-codex-spark",
      "--expect-model", "gpt-5.4-mini",
      "--allow-missing-guidance",
    ])).stdout);

    assert.equal(result.ok, true);
    assert.deepEqual(result.spawn_batches, [[2, 2]]);
    assert.equal(result.spawn_calls.length, 2);
    assert.deepEqual(result.current_parent_lanes.counts, { closed: 2 });
    assert.equal(result.spawn_calls[0].source, "nested");
    assert.equal(result.spawn_calls[0].created_agent_id, "child1");
    assert.equal(result.spawn_calls[1].created_agent_id, "child2");
  });
});

test("live-check treats close_agent not-found release evidence as closed", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','closed');",
        "insert into threads values ('child1','/tmp/child1.jsonl','Close Fail','explorer','gpt-5.3-codex-spark','low','One','/tmp',1779075987);",
      ].join(""),
    );
    const transcript = join(home, "parent-close-fail.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"one\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"spawn1","output":"{\\"agent_id\\":\\"child1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close1","arguments":"{\\"target\\":\\"child1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"agent with id child1 not found"}}',
      ].join("\n"),
    );

    const output = JSON.parse((await runScript(liveCheckPath, home, [
      "--transcript", transcript,
      "--expect-all-closed",
      "--allow-missing-guidance",
    ])).stdout);
    assert.equal(output.checks.find((check) => check.name === "successful_spawns_closed").status, "pass");
    assert.equal(output.model_routes[0].closed_after_spawn, true);
    assert.equal(output.close_calls[0].output_failed, true);
  });
});

test("live-check still rejects endpoint-not-found close failures", async () => {
  await withHome(async (home) => {
    await createNativeTables(home);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','closed');",
        "insert into threads values ('child1','/tmp/child1.jsonl','Endpoint Fail','explorer','gpt-5.3-codex-spark','low','One','/tmp',1779075987);",
      ].join(""),
    );
    const transcript = join(home, "parent-endpoint-fail.jsonl");
    await writeFile(
      transcript,
      [
        '{"type":"session_meta","payload":{"id":"parent1"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn1","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"one\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"spawn1","output":"{\\"agent_id\\":\\"child1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close1","arguments":"{\\"target\\":\\"child1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"close1","output":"transport error: endpoint not found"}}',
      ].join("\n"),
    );

    let error;
    try {
      await runScript(liveCheckPath, home, ["--transcript", transcript, "--expect-all-closed", "--allow-missing-guidance"]);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 2);
    const output = JSON.parse(error.stdout);
    assert.equal(output.checks.find((check) => check.name === "successful_spawns_closed").status, "fail");
    assert.equal(output.model_routes[0].closed_after_spawn, false);
    assert.equal(output.close_calls[0].output_failed, true);
  });
});

test("live-check honors configured native DB name", async () => {
  await withHome(async (home) => {
    const customDb = join(home, "custom-state.sqlite");
    await execFileAsync("sqlite3", [
      customDb,
      [
        "create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);",
        "create table threads(id text, rollout_path text, title text, agent_role text, model text, reasoning_effort text, agent_nickname text, cwd text, updated_at integer);",
        "insert into thread_spawn_edges values ('parent1','child1','open');",
      ].join(" "),
    ]);
    await writeFile(
      join(home, "native-agent-pool-advisor.config.json"),
      JSON.stringify({ paths: { state_db_name: "custom-state.sqlite" } }),
    );
    const transcript = join(home, "parent-custom-db.jsonl");
    await writeFile(transcript, '{"type":"session_meta","payload":{"id":"parent1"}}\n');

    const result = JSON.parse((await runScript(liveCheckPath, home, [
      "--transcript", transcript,
      "--expect-current-open", "1",
      "--allow-missing-guidance",
    ])).stdout);

    assert.equal(result.ok, true);
    assert.equal(result.state_db.path, customDb);
    assert.equal(result.checks.find((check) => check.name === "current_parent_open_count").status, "pass");
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
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spark","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.3-codex-spark\\",\\"reasoning_effort\\":\\"low\\",\\"message\\":\\"SPARK_LANE_OK\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"spark","output":"{\\"agent_id\\":\\"spark1\\",\\"nickname\\":\\"Franklin\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","call_id":"close-spark","arguments":"{\\"target\\":\\"spark1\\"}"}}',
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"close-spark","output":"{\\"previous_status\\":{\\"completed\\":\\"SPARK_LANE_OK\\"}}"}}',
        '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"mini","arguments":"{\\"agent_type\\":\\"default\\",\\"model\\":\\"gpt-5.4-mini\\",\\"reasoning_effort\\":\\"medium\\",\\"message\\":\\"MINI_LANE_OK\\"}"}}',
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

test("docs preserve delegation control boundaries", async () => {
  const readme = await readFile(join(repoRoot, "README.md"), "utf-8");
  const firstPrinciples = await readFile(join(repoRoot, "docs", "first-principles.md"), "utf-8");
  const runtimeAudit = await readFile(join(repoRoot, "docs", "runtime-audit.md"), "utf-8");
  const checklist = await readFile(join(repoRoot, "docs", "release-checklist.md"), "utf-8");
  const docs = [readme, firstPrinciples, runtimeAudit, checklist].join("\n");

  assert.match(docs, /completed lane (?:open )?only for the same active task\/window/i);
  assert.match(docs, /Close only stale, unrelated, wrong-model, capacity-needed, or active-task-complete lanes/i);
  assert.match(docs, /agent_type=default/);
  assert.match(docs, /gpt-5\.6-luna/);
  assert.match(docs, /gpt-5\.6-terra/);
  assert.match(docs, /gpt-5\.6-sol/);
  assert.match(docs, /do not spawn agents/);
  assert.match(docs, /no subagents/);
  assert.match(docs, /subagent-relevant read-heavy, multi-slice/);
  assert.match(docs, /--forbid-explorer-model/);
  assert.match(docs, /runtime owns availability/);
  assert.match(docs, /semantic role/);
  assert.match(docs, /current_parent_lanes/);
  assert.match(docs, /tmp=\$\(mktemp -d\)/);
  assert.match(docs, /sqlite3 "\$tmp\/state_5\.sqlite"/);
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

test("parent reset archives visible child threads before deleting edges", async () => {
  await withHome(async (home) => {
    await createNativeTablesWithSourceAndArchiveColumns(home);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await sqlite(
      home,
      [
        "insert into thread_spawn_edges values ('parent1','child1','open'),('parent2','child2','open');",
        "insert into threads values",
        `('child1','/tmp/child1.jsonl','child one','default','gpt-5.4-mini','high','One','/tmp',${nowSeconds},'${subagentSource("parent1", "One")}','subagent',0,null),`,
        `('child2','/tmp/child2.jsonl','child two','default','gpt-5.4-mini','high','Two','/tmp',${nowSeconds},'${subagentSource("parent2", "Two")}','subagent',0,null);`,
      ].join(" "),
    );

    const dryRunResult = JSON.parse((await runScript(resetPath, home, ["--parent", "parent1", "--dry-run"])).stdout);
    assert.equal(dryRunResult.visible_subagents_before, 1);

    const result = JSON.parse((await runScript(resetPath, home, [
      "--parent",
      "parent1",
      "--force",
      dryRunResult.force_token,
    ])).stdout);

    assert.equal(result.archived_visible_subagents, 1);
    assert.equal(
      await sqliteReadonly(home, "select id,archived from threads order by id;"),
      "child1|1\nchild2|0",
    );
    assert.equal(
      await sqliteReadonly(home, "select parent_thread_id,status,count(*) from thread_spawn_edges group by parent_thread_id,status order by parent_thread_id;"),
      "parent2|open|1",
    );
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

# Runtime Audit

## Live Surfaces

- Active user hook config: `~/.codex/hooks.json`.
- Active advisor path: `~/.codex/hooks/native-agent-pool-advisor.mjs`.
- Advisor state: `~/.codex/state/native-agent-pool-advisor.json`.
- Optional advisor config: `~/.codex/native-agent-pool-advisor.config.json`.
- Native Codex state: `~/.codex/state_5.sqlite`, especially `thread_spawn_edges`.
- Native cap: `~/.codex/config.toml` `[agents].max_threads`.
- Spawn safety is scoped to the current parent/session. The admission slice is `thread_spawn_edges.parent_thread_id = <current parent thread>`.

## Hidden Branches

- `~/.codex/hooks/quiet-omx-status-self-heal.mjs` runs on `SessionStart` and can normalize live hook registration.
- `~/.codex/hooks.json.backup.*` and `~/.codex/hooks.json.preprobe` contain older hook layouts and matchers.
- `~/.omx/backups/setup/**/.codex/hooks.json` can replay old setup-time hook stacks.
- `oh-my-codex` setup currently strips legacy `codex-native-hook.js` managed entries, but setup/restore behavior still depends on user-scope config and backups.
- Backup DBs such as `state_5.sqlite.backup-*` are not read by the advisor unless manually restored over `state_5.sqlite`.

## Theory vs Runtime Fixes

- Wrapper/nested tool calls are inspected for agent operations, so `multi_tool_use.parallel` cannot hide `spawn_agent`.
- Normal admission must never use a global native edge count. Other parent sessions can be shown by repair tooling, but they are not current-turn capacity evidence.
- Unscoped spawn hook payloads must block instead of falling back to a shared `cwd` ledger. Capacity is per parent/session; unknown parent identity is unsafe.
- A readable empty current-parent native edge slice is authoritative for that parent/session. Transcript and child-session fallback are only used when current-parent native evidence is unavailable.
- Transcript and child-session fallback ignore events older than the reset marker.
- General evidence collection does not repair native edges. Successful `PostToolUse(close_agent)` for the current parent/session marks a native edge closed and decrements slot pressure; runtime `not found` / `unknown agent` close evidence is also repaired because the lane is no longer reachable by Codex.
- Wrapped `multi_tool_use.parallel` evidence is normalized before accounting, so nested `spawn_agent`, `wait_agent`, and `close_agent` calls update the same budget model as direct tool calls.
- Multiple `spawn_agent` calls inside one wrapper consume multiple requested slots before the hook decides whether to block.
- Slot pressure is saturated to the native cap. If SQLite reports more `open` edges than the cap, those rows are reported as `db_open_edge_debt` / `open_edge_overflow`, not as more live agents or `occupied > cap`.
- `SessionStart` is a first-class guidance surface for parent sessions. It emits current budget pressure after compaction/resume even when there is no fresh `UserPromptSubmit` event before the next tool call.
- Child sessions receive no proactive prompt-time delegation guidance. A child should not own recursive delegation; it reports escalation needs upward and the parent leader owns reuse, close, and relaunch.
- Model selection is mandatory for every `spawn_agent` call. Missing `model` inherits the parent model; the default explicit choice is mini unless the leader judges that Spark or 5.5 fits the work better. This is hard-blocked only when Codex emits a supported `PreToolUse` event for the spawn path.
- Explorer model routing is an allow-list plus advisory contract guidance, not a single hard-coded model and not a task-shape blocker. Spark is for near-instant scout/probe work, mini is the default reasoning/light-executor lane, and 5.5 is for critic/architecture/security/high-risk/final-approval work.
- Complex explorer prompts on Spark are allowed when Spark is used as a bounded scout/anchor collector. The hook only advises the agent to cap scope/output or escalate synthesis/edit/final-approval follow-up to mini or a frontier reviewer.
- Current-session terminal lanes still consume local budget until `close_agent` succeeds.
- `send_input`, `wait_agent`, and child `task_complete` evidence do not reduce current-parent pressure. A successful `close_agent` is the normal decrement path; runtime not-found close evidence is the stale-unreachable exception.
- A zero-budget prompt is only a capacity snapshot. After a successful close or runtime not-found repair, the next hook or `PreToolUse` capacity check replaces the old snapshot; agents must not keep treating stale zero-budget text as current authority.
- Successful `close_agent` repair is keyed by current parent/session plus `child_thread_id`; it must not mutate unrelated parent rows.
- Native SQLite `open` edges whose child transcript has `task_complete` are completed-not-closed candidates. They still count for current-parent admission until close succeeds or an explicit reset removes stale state.
- Long child transcripts must still be scanned for `task_complete` outside the terminal tail window before an open edge is labeled active.
- If the advisor state lock or native edge query is unavailable during a supported `PreToolUse(spawn_agent)` event, the hook blocks conservatively.
- Automatic hook maintenance does not prune Codex SQLite. SQLite mutation is limited to successful close-agent repair and the explicit reset tool.

## End-To-End Runtime Finding

The project must not treat synthetic `PreToolUse(spawn_agent)` tests as proof that Codex Desktop or CLI native subagent creation is interceptable. OpenAI's current Codex hook documentation lists `PreToolUse` support for Bash, `apply_patch`, and MCP tool names; native `spawn_agent` is not listed as a documented hard-block target.

Observed Desktop evidence showed a missing-model native `spawn_agent` call create a child thread and native edge without prior advisor markers in the parent transcript. In that runtime, the hook's hard-block branch was not reached. The correct operational claim is therefore:

- `SessionStart` and `UserPromptSubmit` can provide prompt-time guidance when emitted.
- `PreToolUse` can hard-block only tool paths that Codex actually routes through that hook event.
- `PostToolUse` and SQLite reconciliation can diagnose and repair state after supported close/spawn evidence appears.
- Real validation requires transcript/SQLite evidence, not just `doctor`.

Use the read-only live checker for that evidence:

```bash
node scripts/live-check.mjs --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl
```

The live checker supports expectation-based E2E gates:

- `--expect-model <model>` verifies that a successful `spawn_agent` tool input and its native SQLite child row both used that model. Repeat it to cover Spark, mini, and frontier lanes.
- `--expect-current-open <n>` verifies the current parent/session open-edge count after the scanned transcript window.
- `--expect-all-closed` verifies every successful spawn in the scanned window has both a successful close call and a closed native edge.
- `--require-guidance` treats missing prompt-time advisor markers as a failure; `--allow-missing-guidance` keeps model/capacity verification independent from Codex transcript marker availability.

The capacity E2E should stop at six real child lanes. At `open=6`, the live `UserPromptSubmit` hook must report `SPAWN_AGENT_DISABLED_THIS_TURN=true`, `occupied=6/6`, and `remaining_spawn_budget=0`. Do not launch a seventh child to prove the cap. If a later close succeeds, verify that a fresh hook/live check reports the reduced open count before spawning.

## Remaining Risk

The hook cannot prove that every future Codex Desktop or CLI spawn path will emit `PreToolUse`. In current observed Desktop native-spawn behavior, that assumption has already failed. That is why `SessionStart` and `UserPromptSubmit` both inject budget guidance and why `spawn_agent` batching is discouraged even when the hook appears healthy.

The reset script intentionally mutates `thread_spawn_edges`. It should be treated as an operator repair command, not normal hook execution.

Reset is two-phase by design: dry-run computes the affected scope and a force token; mutation requires that token. Global reset also requires `--confirm-global-reset`.

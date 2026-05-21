# Runtime Audit

## Live Surfaces

- Active user hook config: `~/.codex/hooks.json`.
- Active advisor path: `~/.codex/hooks/native-agent-pool-advisor.mjs`.
- Advisor state: `~/.codex/state/native-agent-pool-advisor.json`.
- Optional advisor config: `~/.codex/native-agent-pool-advisor.config.json`.
- Native Codex state: `~/.codex/state_5.sqlite` by default, especially `thread_spawn_edges`. `NATIVE_AGENT_POOL_STATE_DB_NAME`, `NATIVE_AGENT_POOL_STATE_DB_PATH`, or advisor config can move this path, and `live-check` must honor the same override.
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
- A readable empty current-parent native edge slice is authoritative for persisted native rows, but it does not erase a successful local spawn ledger before native edges catch up. Transcript and child-session fallback are only used when current-parent native evidence is unavailable.
- Transcript and child-session fallback ignore events older than the reset marker.
- General evidence collection does not repair native edges. Successful `PostToolUse(close_agent)` for the current parent/session marks a native edge closed and decrements slot pressure; explicit agent-target missing evidence such as `unknown agent` or `agent with id ... not found` is also repaired because the lane is no longer reachable by Codex. Unrelated failures such as `endpoint not found` are not release evidence. If the close hook payload is mis-scoped, a target child id repairs only when it maps to exactly one non-closed native edge; ambiguous child ids remain open.
- Wrapped `multi_tool_use.parallel` evidence is normalized before accounting, so nested `spawn_agent`, `wait_agent`, and `close_agent` calls update the same budget model as direct tool calls.
- Multiple `spawn_agent` calls inside one wrapper are counted before the hook decides whether to block. Without a Codex runtime reservation primitive, supported `PreToolUse` surfaces block multi-spawn batches even when the observed free-slot count is high enough.
- Prompt-time spawn allowance is an observed snapshot for the current parent/session, not an atomic reservation. `observed_free=3` / `remaining_spawn_budget=3` means three slots were observed free at sampling time; the safe launch protocol is one child, then a fresh capacity check before another child. If any spawn returns a capacity failure, later prompts must treat that runtime cap-hit as diagnostic unless current native edge state is unreadable; when native rows are readable, the scoped open-edge count plus pending reservations owns admission.
- Slot pressure is saturated to the native cap. If SQLite reports more `open` edges than the cap, those rows are reported as `db_open_edge_debt` / `open_edge_overflow`, not as more live agents or `occupied > cap`.
- Historical cap-hit evidence is split from admission blocking. `cap_hit_after_last_close=yes` with readable current native rows must not inflate a below-cap parent/session to `occupied=6/6`. It blocks only when native rows are unavailable, where the hook cannot safely distinguish a real full runtime pool from a stale prompt snapshot.
- `SessionStart` is a first-class guidance surface for parent sessions. The installer registers it for startup, resume, and clear so it emits current budget pressure after compaction/resume or replacement-thread creation even when there is no fresh `UserPromptSubmit` event before the next tool call.
- Child sessions receive no proactive prompt-time delegation guidance. A child should not own recursive delegation; it reports escalation needs upward and the parent leader owns reuse, close, and relaunch.
- Model selection is mandatory for every non-fork `spawn_agent` call. Missing, blank, null, or non-string `model` values inherit or fail ambiguously and are treated as missing. The default explicit choice is mini unless the leader judges that Spark or 5.5 fits the work better. This is hard-blocked only when Codex emits a supported `PreToolUse` event for the spawn path.
- `fork_context=true` is a runtime shape exception, not a model-routing strategy. If Codex rejects `fork_context=true` with `model`, the agent should remove `fork_context` and pass compact context for Spark/mini/frontier routing, or omit `model` only when exact full-history fork is more important than model choice. That shape failure must not be treated as native-pool exhaustion.
- The hook does not route by `agent_type`. The enforceable model boundary is the explicit `model` field in the tool input, except for boolean `fork_context=true`. Spark is for near-instant scout/probe work, mini is the default reasoning/light-executor lane, and 5.5 is for critic/architecture/security/high-risk/final-approval work.
- Complex tasks may still use Spark when Spark is used as a bounded scout/anchor collector. That judgment belongs in `AGENTS.md` and the child task contract, not in an `agent_type` hard block.
- `send_input` and `wait_agent` do not reduce current-parent pressure. A successful `close_agent` is the normal decrement path; verified agent-target-not-found close evidence and child-transcript `task_complete` repair are stale-unreachable/stale-completed exceptions.
- Current-parent lane inventory is a parent-side reuse aid. `LANE_REUSE_CHECK_REQUIRED=true` means the leader must compare the intended task contract against listed open/completed-not-closed lanes before spawning. It must not be a hard semantic block, because the hook cannot prove topic equivalence safely.
- A zero-budget prompt is only a capacity snapshot. After a successful close or runtime not-found repair, the next hook or `PreToolUse` capacity check replaces the old snapshot; agents must not keep treating stale zero-budget text as current authority.
- At zero budget, the prompt must include recovery actions rather than only a prohibition. Valid recovery actions are: reuse a compatible current-parent lane, close listed no-longer-needed lane(s), wait for a needed active lane, or continue locally.
- Successful `close_agent` repair is keyed by current parent/session plus `child_thread_id`; the only cross-parent fallback is unique-child not-found repair. When native evidence is unavailable, a target-missing close can advance fallback capacity only if the id is already known as an active lane in the current session or transcript. It must not mutate ambiguous unrelated parent rows or treat typos as release evidence.
- Native SQLite `open` edges whose child transcript has `task_complete` are stale-completed repair candidates. The hook repairs them to `closed` and excludes them from current-parent admission.
- Long child transcripts must still be scanned for `task_complete` outside the terminal tail window before an open edge is labeled active.
- If the advisor state lock or native edge query is unavailable during a supported `PreToolUse(spawn_agent)` event, the hook blocks conservatively.
- Automatic hook maintenance does not prune unrelated Codex SQLite history. SQLite mutation is limited to current-parent close-agent repair, unique not-found repair, stale `task_complete` open-edge repair, and the explicit reset tool.

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
- `--expect-all-closed` verifies every successful spawn in the scanned window has a closed native edge plus either successful close output or verified not-found release evidence. Transport failures such as `endpoint not found` are not release evidence.
- `--require-guidance` treats missing prompt-time advisor markers as a failure; `--allow-missing-guidance` keeps model/capacity verification independent from Codex transcript marker availability.
- Live-check records same-response spawn batches, including nested `multi_tool_use.parallel` agent calls, so real runtime transcripts can expose batch attempts and partial failures. Under the current no-reservation protocol, those batches are not considered valid just because they fit the observed free-slot count. Live-check fails when spawn outputs are missing, spawn/close outputs show runtime/tool failure, missing-model child creation occurs, explorer lanes are created with forbidden frontier models, tool/native model rows disagree, or expectation mismatches.

The capacity E2E should stop at six real child lanes. At `open=6`, the live `UserPromptSubmit` hook must report `SPAWN_AGENT_DISABLED_THIS_TURN=true`, `occupied=6/6`, `observed_free=0`, and `remaining_spawn_budget=0`. Do not launch a seventh child to prove the cap. If a later close succeeds, verify that a fresh hook/live check reports the reduced open count before spawning.

## Remaining Risk

The hook cannot prove that every future Codex Desktop or CLI spawn path will emit `PreToolUse`. In current observed Desktop native-spawn behavior, that assumption has already failed. That is why `SessionStart` and `UserPromptSubmit` both inject budget/model guidance, and why `PostToolUse` cap-hit evidence is preserved as a warning while readable current-parent native rows remain the admission source.

The reset script intentionally mutates `thread_spawn_edges`. It should be treated as an operator repair command, not normal hook execution.

Reset is two-phase by design: dry-run computes the affected scope and a force token; mutation requires that token. Global reset also requires `--confirm-global-reset`.

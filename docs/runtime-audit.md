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
- Closed native edges and active thread-list visibility are separate surfaces. A closed edge must not count against the six-slot runtime pool, but an unarchived current-parent child thread can still appear as an active/closable runtime lane. Admission therefore counts current-parent `threads.archived=0` subagent rows as slot pressure until they are archived. When the Codex `threads` table has `archived` fields, the hook best-effort archives child thread rows after close/closed-edge repair and during periodic closed-edge maintenance so active thread/subagent lists do not accumulate hundreds of historical child sessions.
- Wrapped `multi_tool_use.parallel` evidence is normalized before accounting, so nested `spawn_agent`, `wait_agent`, and `close_agent` calls update the same budget model as direct tool calls.
- Multiple `spawn_agent` calls inside one wrapper are counted before the hook decides whether to block. Supported `PreToolUse` surfaces admit the batch only when `requested_spawns <= observed_free`; otherwise the batch is blocked before the long prompts are spent.
- Prompt-time spawn allowance is an observed snapshot for the current parent/session, not an atomic future reservation. `observed_free=3` / `remaining_spawn_budget=3` means three slots were observed free at sampling time. A matching same-tool batch can be locally reserved by the immediate `PreToolUse` hook, but another later batch must wait for a fresh capacity check. If any spawn returns a capacity failure, later prompts treat that runtime cap-hit as blocking only when current authoritative native edge state is unavailable or also at cap. If current authoritative native rows show positive `observed_free`, the older cap-hit is diagnostic and must not be restated as zero capacity.
- Positive-budget prompt guidance is intentionally compact unless there is current-parent lane pressure, invalid spawn shape, zero budget, unreadable native state, or narrow explicit spawn intent. Broad words such as review, research, verify, and parallel are delegation-policy signals for the parent, not hook-side semantic classifiers.
- Explicit negative intent is applied before prompt matching. Phrases such as "do not spawn agents" or "no subagents" should suppress prompt-triggered spawn guidance unless an actual spawn tool payload is visible.
- Slot pressure is saturated to the native cap. If SQLite reports more `open` edges than the cap, those rows are reported as `db_open_edge_debt` / `open_edge_overflow`, not as more live agents or `occupied > cap`.
- Historical cap-hit evidence is split from stale prompt guidance. `cap_hit_after_last_close=yes` is not itself admission-blocking; `cap_hit_blocks_spawn=yes` is the hard stop. Current authoritative parent/session native rows showing positive free slots override stale cap-hit pressure.
- `SessionStart` is a first-class guidance surface for parent sessions. The installer registers it for startup, resume, and clear so it emits current budget pressure after compaction/resume or replacement-thread creation even when there is no fresh `UserPromptSubmit` event before the next tool call.
- Child sessions receive no proactive prompt-time delegation guidance. A child should not own recursive delegation; it reports escalation needs upward and the parent leader owns reuse, close, and relaunch.
- Model selection is mandatory for every non-fork `spawn_agent` call. Missing, blank, null, or non-string `model` values inherit or fail ambiguously and are treated as missing; native `agent_type` is not an exception. The permitted routes are Luna, Terra, and Sol: Terra/medium is the daily default, Luna normally starts low for bounded high-throughput evidence work and mechanical checks, and Sol is reserved for the hardest judgment. Choose effort from the task contract; Sol/high and Sol/xhigh are not defaults. This is hard-blocked only when Codex emits a supported `PreToolUse` event for the spawn path.
- Native `fork_context=true` is disabled. It inherits the already-running parent model and effort, so it cannot satisfy per-lane routing. Pass compact context for Luna/Terra/Sol routing instead; this is not native-pool exhaustion.
- Native `agent_type` availability is runtime-owned. If Codex accepts `agent_type=code-reviewer`, it must be allowed to run; if Codex rejects it, retry once with `agent_type=default`, the same semantic role in message/title/task contract, and the explicit model. A specialist on native `default` is not fallback behavior; it is the compatible transport for an identity-bearing specialist prompt when a special runtime type is unavailable.
- Agents must not keep probing unavailable native role names. A failed `agent_type=critic`, `agent_type=code-reviewer`, `agent_type=researcher`, or `agent_type=explore` call is a runtime availability failure and should not lead to repeated retries or missing-model fallback.
- The hook does not route by `agent_type`. The enforceable model boundary is the explicit `model` field in every routed tool input; native fork inheritance is disabled. Luna is the bounded fast evidence lane for files/symbols/logs/DB rows/extraction/mechanical checks, Terra is the absolute daily reasoning and implementation lane, and Sol is reserved for highest-risk architecture/security/final-approval judgment.
- Luna requires a bounded investigation contract: scope, output cap, and stop condition. It can cover several related read-only slices and return a direct evidence-led finding. Do not give it unbounded dumps, persistent frontier duties, shared edits, broad synthesis, or absence verdicts. If a Luna lane compacts, reduce the slice or move the synthesis to Terra.
- `send_input` and `wait_agent` do not reduce current-parent pressure. A successful `close_agent` is the normal decrement path; verified agent-target-not-found close evidence is the stale-unreachable exception.
- Current-parent lane inventory is a parent-side reuse aid. `LANE_REUSE_CHECK_REQUIRED=true` means the leader must compare the intended task contract against listed open/completed-not-closed lanes before spawning. Runtime hook guidance lists stable scheduling fields only and omits child titles/task prompts, because prompt text can carry stale instructions or distracting terms back into the parent context. It must not be a hard semantic block, because the hook cannot prove topic equivalence safely.
- Completed lanes are reusable context only for the same active task/window when near-term follow-up is likely. They should close when stale, unrelated, wrong-topic/model, capacity-needed, or when the active task window is complete.
- The control system also prevents silent under-delegation: for subagent-relevant read-heavy, multi-slice, or explicitly parallel work, the leader should choose reuse, spawn up to observed free capacity in the same observable tool call and resample after the tool result, or local execution with a concrete reason such as user-forbidden spawning, tiny task size, urgency, or blocked evidence.
- A zero-budget prompt is only a capacity snapshot. After a successful close or runtime not-found repair, the next hook or `PreToolUse` capacity check replaces the old snapshot; agents must not keep treating stale zero-budget text as current authority.
- At zero budget, the prompt must include recovery actions rather than only a prohibition. Valid recovery actions are: reuse a compatible current-parent lane, close listed no-longer-needed lane(s), wait for a needed active lane, or continue locally.
- Successful `close_agent` repair is keyed by current parent/session plus `child_thread_id`; the only cross-parent fallback is unique-child not-found repair. Current-parent target-missing repair also accepts a unique lane `agent_nickname` or exact title match, because the Codex UI can ask to close a short name such as `LaneAlpha` rather than a UUID-like child id. Ambiguous, unknown, typo, or repeated not-found targets do not free capacity; they are recorded as unreachable so later guidance stops recommending the same bad close target.
- Native SQLite `open` edges whose child transcript has `task_complete` are `completed_not_closed` close candidates. They still consume capacity until `close_agent` succeeds or runtime not-found close repair proves the lane is no longer reachable.
- Long child transcripts must still be scanned for `task_complete` outside the terminal tail window before an open edge is labeled active instead of completed-not-closed.
- If the advisor state lock or native edge query is unavailable during a supported `PreToolUse(spawn_agent)` event, the hook blocks conservatively.
- Automatic hook maintenance does not prune unrelated Codex SQLite history. SQLite mutation is limited to current-parent close-agent repair, unique not-found repair, archiving child thread rows whose edge is already `closed`, and bounded pruning of expired `closed` `thread_spawn_edges`. The maintenance path never deletes `open` rows and runs at most every 6 hours.
- Optional stale-open repair is disabled unless `NATIVE_AGENT_POOL_STALE_OPEN_EDGE_RETENTION_HOURS` or the matching advisor config value is set. When enabled, it repairs only current-parent `open` rows whose `threads.updated_at` is older than the configured retention. This is for old DB debt, not for closing fresh completed lanes immediately after every task.

## End-To-End Runtime Finding

The project must not treat synthetic `PreToolUse(spawn_agent)` tests as proof that Codex Desktop or CLI native subagent creation is interceptable. OpenAI's current Codex hook documentation lists `PreToolUse` support for Bash, `apply_patch`, and MCP tool names; native `spawn_agent` is not listed as a documented hard-block target.

Observed Desktop evidence showed a missing-model native `spawn_agent` call create a child thread and native edge without prior advisor markers in the parent transcript. In that runtime, the hook's hard-block branch was not reached. The correct operational claim is therefore:

- `SessionStart` and `UserPromptSubmit` can provide prompt-time guidance when emitted.
- `PreToolUse` can hard-block only tool paths that Codex actually routes through that hook event.
- `PostToolUse` and SQLite reconciliation can diagnose and repair state after supported close/spawn evidence appears. `PreCompact` injects a remote-compact risk warning before Codex attempts compaction because compact can fail at any model's effective context boundary once system/developer/AGENTS/tool-schema/tool-output reserve is too large for the compact payload. `PostCompact` re-injects a compact spawn-shape contract because successful compaction can remove the earlier SessionStart/UserPromptSubmit guidance while leaving the model free to delegate on the next turn.
- Real validation requires transcript/SQLite evidence, not just `doctor`.

Use the read-only live checker for that evidence:

```bash
node scripts/live-check.mjs --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl
```

The live checker supports expectation-based E2E gates:

- `--expect-model <model>` verifies that a successful `spawn_agent` tool input and its native SQLite child row both used that model. Repeat it to cover Luna, Terra, and Sol lanes.
- `--forbid-explorer-model <model>` fails non-fork native `agent_type=explorer` spawns that use the listed model. It is repeatable and defaults include `gpt-5.6-sol`; native explorer is not allowed by default unless you pass `--allow-agent-type explorer` from proven runtime evidence.
- `--expect-current-open <n>` verifies the current parent/session open-edge count after the scanned transcript window.
- `--expect-all-closed` verifies every successful spawn in the scanned window has a closed native edge plus either successful close output or verified not-found release evidence. Transport failures such as `endpoint not found` are not release evidence.
- `--require-guidance` treats missing prompt-time advisor markers as a failure; `--allow-missing-guidance` keeps model/capacity verification independent from Codex transcript marker availability.
- Live-check records same-response spawn batches, including nested `multi_tool_use.parallel` agent calls, so real runtime transcripts can expose batch attempts and partial failures. Those batches are valid only when the immediate hook snapshot could fit the requested count and the runtime actually created the expected children. Live-check also reports `current_parent_lanes` with lane status, role, model, reasoning effort, nickname, title, and `updated_at` for offline diagnosis; unlike hook prompt guidance, this JSON may include titles because it is not injected into the parent agent's next-token context by default. It fails when spawn outputs are missing, spawn/close outputs show runtime/tool failure, missing-model child creation occurs, runtime returns `agent type is currently not available`, configured explorer lanes are created with forbidden frontier models, tool/native model rows disagree, or expectation mismatches. Native agent-type allow-list checks are optional diagnostics and disabled by default.

The capacity E2E should stop at six real child lanes. At `open=6`, the live `UserPromptSubmit` hook must report `SPAWN_AGENT_DISABLED_THIS_TURN=true`, `occupied=6/6`, `observed_free=0`, and `remaining_spawn_budget=0`. Do not launch a seventh child to prove the cap. If a later close succeeds, verify that a fresh hook/live check reports the reduced open count before spawning.

## Remaining Risk

The hook cannot prove that every future Codex Desktop or CLI spawn path will emit `PreToolUse`. In current observed Desktop native-spawn behavior, that assumption has already failed. That is why `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `PostCompact` inject budget/model or compact spawn-shape guidance. `PostToolUse` cap-hit evidence is retained, but it becomes a hard negative admission authority only when current native edge state is unavailable or also at cap; a current authoritative positive-capacity snapshot wins over stale cap-hit pressure.

Remote compaction is a runtime boundary, not a Luna-only routing issue. Luna, Terra, and Sol lanes each compact at their own effective context limits. This hook cannot trim Codex's compact input or guarantee remote compact success; it can only warn before compact, restore compacted-away model/capacity guidance after compact, and tell the leader to stop adding context in an already-overfull thread.

The reset script intentionally mutates `thread_spawn_edges`. It should be treated as an operator repair command, not normal hook execution.

Reset is two-phase by design: dry-run computes the affected scope and a force token; mutation requires that token. Global reset also requires `--confirm-global-reset`.

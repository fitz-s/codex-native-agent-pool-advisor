# Codex Native Agent Pool Advisor

Guardrail hook for Codex native subagents in Codex Desktop and Codex CLI installs that use the shared `~/.codex` hook/state runtime. It prevents the recurring failure mode where an agent spends a long prompt on a new reviewer/verifier/explorer, hits the six-subagent native pool cap, then burns more context and attention closing old lanes and retrying.

Project page: <https://fitz-s.github.io/codex-native-agent-pool-advisor/>

## What Problem It Solves

Codex can delegate work to native subagents, but the pool limit is easy for the model to lose track of during long tasks. The expensive failure looks like this:

1. The leader writes a detailed child-agent prompt.
2. Runtime rejects the spawn because the native pool is already full.
3. The leader explains the failure, closes several agents, restates the prompt, or tries a different batch.
4. The thread loses context budget and attention before any useful review, verification, or exploration happens.

This hook makes that category of waste visible and harder to repeat. It injects the current parent/session budget, blocks doomed spawns only on Codex tool surfaces that actually emit `PreToolUse`, treats successful `close_agent` as the only normal slot release, and separates capped runtime slot pressure from stale or unresolved `open` edge debt.

Model routing is secondary but explicit. Every non-fork subagent must choose a current 5.6 route: Terra is the daily engineering default, Luna handles bounded high-throughput evidence work and mechanical checks, and Sol is reserved for the hardest judgment.

The original goal is not "close every child as soon as possible." It is to keep useful subagent context off the main thread without wasting slots. The parent leader should reuse same-topic lanes with `send_input`, close only obsolete or wrong-model lanes, and launch new children only after capacity and model choice are explicit.

Native subagent use does not require the user to explicitly say "spawn a subagent." If the task is independent, read-heavy, multi-slice, review-heavy, or needs an independent verifier, the parent should use or reuse child agents when the current parent/session has capacity. For complex investigation, review, verification, live-state diagnosis, or broad implementation planning, the default shape is multi-agent: the leader integrates, a bounded scout maps evidence, and a verifier/critic attacks the likely conclusion. This is separate from user-visible `create_thread` / `fork_thread` operations, which do require explicit user intent.

## Compatibility

- Works with Codex Desktop and Codex CLI when they read the same `~/.codex/hooks.json`, hook events, and native SQLite state layout.
- Uses `CODEX_HOME` when set; otherwise defaults to `~/.codex`.
- Reads native pool state from `state_5.sqlite` by default. Override the DB name/path if a Codex build moves it.
- Installs for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `PostCompact`; run `node scripts/doctor.mjs` after install to confirm registration, hash, and native DB reachability.
- `doctor` does not prove that a future native `spawn_agent` call will emit `PreToolUse`. Use `node scripts/live-check.mjs --transcript <path>` against a real Codex transcript for end-to-end evidence.

## Runtime Model

See [First-Principles Design](docs/first-principles.md) for the full boundary model.

- Spawn admission is scoped to the current parent/session. The advisor reads native `thread_spawn_edges` rows where `parent_thread_id` matches the current parent thread; rows from other parent sessions do not affect this turn's budget.
- There is no global runtime pool counter in normal admission. Global reset tools are operator repair surfaces for stale state, not spawn-budget authority.
- A spawn hook payload without `session_id`, `thread_id`, transcript `session_meta`, or `parent_thread_id` is unscoped and blocks conservatively. It must not fall back to a shared working-directory bucket.
- Native cap comes from `~/.codex/config.toml` `[agents].max_threads`, defaulting to 6.
- `occupied` is a saturated current-parent runtime slot estimate and is never reported above the cap. Extra current-parent `open` rows are surfaced separately as `db_open_edge_debt` and `open_edge_overflow`; they are persistent-state repair debt, not additional live subagents.
- Successful `spawn_agent` consumes a slot immediately in the local ledger. If native `thread_spawn_edges` is readable but has not caught up yet, that ledger lag still counts against admission until a matching native row appears, the lane closes, or the local running-lane TTL expires.
- A capacity-failed spawn consumes no new slot. It blocks later spawns only when the current parent/session native edge state is unavailable or also at cap; if current authoritative native rows show positive `observed_free`, the older cap-hit is diagnostic and must not be restated as zero capacity.
- `observed_free` is the current parent/session free-slot snapshot. `remaining_spawn_budget` is kept only as a compatibility alias for that observed count; it is not an atomic runtime reservation and should not be treated as a guaranteed batch size.
- Without a Codex-internal reservation primitive, launch sequencing is observed-snapshot based. A supported `PreToolUse` surface allows a same-tool spawn batch only when `requested_spawns <= observed_free`; the hook never persists a local reservation into a later turn because native `PostToolUse` correlation is not reliable. Native edges are the cross-turn capacity authority.
- Spawn admission is independent of advisor state. For a supported spawn precheck, the hook reads only the current-parent native edge snapshot and current tool input. It never reads or writes advisor state, scans transcripts, sanitizes context, or runs maintenance on that path; an unreadable native edge query remains fail-closed.
- `wait_agent`, child completion notifications, and `send_input` do not by themselves free a native slot.
- Native `open` rows whose child transcript already has `task_complete` are `completed_not_closed` close candidates. They still consume capacity until `close_agent` succeeds or runtime not-found close repair proves the lane is no longer reachable.
- Old `closed` rows are periodic maintenance data, not capacity authority. The hook prunes expired closed edges in bounded batches so `thread_spawn_edges` does not grow forever; `open` rows are never pruned by this maintenance path.
- Codex can still surface unarchived child thread rows as active/closable lanes even when the matching edge is missing or already `closed`. Current-parent `threads.archived=0` subagent rows therefore count as slot pressure until archived. Maintenance best-effort archives child thread rows whose edge is already `closed`.
- When current-parent lanes exist, prompt-time guidance includes `LANE_REUSE_CHECK_REQUIRED=true` and a compact lane inventory with id, nickname, role, model, status, and `updated_at`. It deliberately does not echo arbitrary child titles/task prompts, because those can carry stale instructions or distracting terms back into the parent context. The inventory is not a semantic hard block: the hook cannot know whether two tasks are truly the same topic. It gives the parent enough scheduling evidence to reuse a compatible lane before spending another native slot.
- Positive-budget prompt guidance is intentionally short when there is no current-parent lane pressure, invalid spawn shape, narrow spawn intent, unreadable native state, or zero budget. Broad words such as review, research, verify, or parallel do not by themselves trigger a long hook lecture.
- Explicit negative intent wins before prompt keyword matching: phrases such as "do not spawn agents" or "no subagents" suppress prompt-triggered spawn guidance unless an actual spawn tool payload is visible.
- A zero-budget prompt is a capacity snapshot, not a permanent turn fact. If a later `close_agent` succeeds or runtime not-found close evidence repairs a stale lane, the next hook or `PreToolUse` capacity check is authoritative and should replace the old zero-budget text.
- A zero-budget prompt also emits a recovery protocol. The agent should not stop at "the pool is full"; it must choose between reusing a compatible current-parent lane, closing listed no-longer-needed lane(s), waiting for a needed active lane, or continuing locally.
- The hook decrements and mutates Codex SQLite on exact successful `PostToolUse(close_agent)` evidence for the current parent/session. Explicit agent-target missing evidence such as `unknown agent` or `agent with id ... not found` is also treated as a stale-unreachable lane and repaired to `closed`; unrelated errors such as `endpoint not found` do not free capacity.
- When a native child edge is closed or repaired to `closed`, the hook also best-effort archives that child row in Codex's `threads` table when the table has `archived` fields. Maintenance repeats that archive step for old closed edges so active thread/subagent lists do not keep exposing stale closed lanes.
- Runtime agent-target-not-found close evidence releases a stale-unreachable lane when the current parent owns the matching native edge row. Current-parent repair accepts either the child id or a unique exact lane nickname/title such as `LaneAlpha`, because Codex can request close by UI name. If a PostToolUse payload is mis-scoped but the target child id has exactly one non-closed native edge anywhere in the DB, the hook repairs that unique parent/child row. Ambiguous, unknown, typo, or repeated not-found targets do not free capacity and are not re-listed as preferred close candidates.
- Optional stale-open repair can close very old current-parent `open` rows whose `threads.updated_at` is older than the configured retention. This is disabled by default in the package because fresh completed lanes can be valuable for reuse; enable it only to repair persistent state debt that no current parent can realistically close.
- Child transcript terminal detection checks beyond the tail window when needed, so a long transcript with an earlier `task_complete` can still be repaired instead of being mislabeled as an active open lane.
- A supported `PreToolUse(spawn_agent)` never falls back to historical transcripts: unreadable native edge evidence blocks. Transcript fallback remains a non-admission diagnostic/lifecycle view only and never imports slots from other sessions.
- Child sessions do not receive proactive prompt-time delegation guidance. A child that needs more delegation should report that recommendation upward; the parent leader owns slot closure and relaunch.
- Every non-fork `spawn_agent` call must include an explicit `model` from `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol`. Omitted model can inherit an unintended parent route, and legacy Spark/5.4/5.5 routes are retired. Native `agent_type` never exempts a lane from this rule. The hook blocks invalid input only when the native spawn call reaches a supported `PreToolUse` surface; otherwise `SessionStart`/`UserPromptSubmit` guidance and live transcript checks are the enforceable surfaces available outside Codex itself.
- Native full-history `fork_context=true` is disabled because it inherits the already-running parent model and reasoning effort. Pass a compact context packet with an explicit Luna/Terra/Sol model and task-appropriate effort instead. This is a routing rule, not native-pool exhaustion.
- Use `gpt-5.6-terra` as the daily default for tracing, diagnosis, research synthesis, implementation, review preparation, and verification. Start at `reasoning_effort=medium`, lower it for straightforward mechanical work, and raise it only when the task contract warrants it. Use `gpt-5.6-luna` for bounded high-throughput search, extraction, log/DB inspection, mechanical checks, and short evidence-led investigations; normally start at `low`. Reserve `gpt-5.6-sol` for the hardest ambiguous architecture, security, live-money/destructive decisions, adversarial critique, or final approval. Sol and high effort are never ordinary defaults.
- `agent_type` is not model-routing input. Omit it unless the actual native tool requires it; role/profile never supplies model or effort. A rejected spawn/tool shape is a configuration error to remove at the source, never a reason to probe another type, retry through a fallback, or create another worker.
- The hook does not choose the model from `agent_type` and does not preempt native type availability. It guards capacity and invalid/wasteful spawn shapes; live-check reports runtime spawn failures and optional agent-type audit results.
- Non-universal settings can live in `~/.codex/native-agent-pool-advisor.config.json` or environment variables.

## Prerequisites

- Codex Desktop or Codex CLI with native subagents, hook events, and `~/.codex/state_5.sqlite`.
- Node.js 22 or newer.
- `sqlite3` on `PATH`.

## Install

```bash
cd codex-native-agent-pool-advisor
npm test
node scripts/install.mjs
node scripts/doctor.mjs
```

The installer copies `hooks/native-agent-pool-advisor.mjs` to `$CODEX_HOME/hooks/` and registers it for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `PostCompact`.

The installer is idempotent: repeated installs should leave one registration per hook event.

## Mandatory Model Selection

The capacity guard does not decide whether Codex should delegate. If the leader has chosen to spawn, the hook requires an explicit model-selection judgment instead of inheriting the parent model by accident. Native role selection never substitutes for an explicit model route.

## Lane Reuse Protocol

Subagents are context lanes, not one-shot function calls. Before spawning a new child, the parent should inspect current-parent lane inventory from the hook output:

- Reuse with `send_input` when an existing lane has the same topic/domain, compatible role/model, and useful prior context.
- Keep a completed lane open only for the same active task/window when near-term follow-up on the same topic is likely; completion does not free the native slot, but it can preserve valuable context.
- Close a lane when it is unrelated, stale, wrong-model for the next task, the active task window is done, or a slot must be freed for higher-value work.
- Do not send orchestration guidance to child lanes. Children report escalation needs upward; the parent owns reuse, close, and relaunch.
- If zero budget is reported and no reusable lane exists, close listed completed-not-closed candidates first; close active lanes only when the parent knows they are no longer needed.

Before deciding to stay local on subagent-relevant read-heavy or multi-slice work, the leader should consciously choose one path: reuse an existing lane, spawn up to the observed free capacity in the same tool call and resample after the tool result, or continue locally because the task is tiny, urgent, user-forbidden, or blocked on evidence the leader is already collecting.

Before spawning, the leader should make a compact task contract:

- `output`: anchors, evidence table, synthesis, patch, critique, or final approval.
- `risk`: read-only, low-risk edit, high-risk edit, security, live-money, destructive, or external side effect.
- `state_depth`: stateless lookup, multi-hop trace, prior-lane context, or final integration.
- `context_size`: exact files/lines, medium slice, large compiled/vendor tree, logs/DB, or unknown.
- `edit_permission`: none, low-risk local, broad local, or external/prod.
- `final_authority`: whether the child may conclude or only return evidence.
- `output_cap` and `stop_condition`: how much the child may return and when it must stop or escalate.

| Model lane | Use for | Boundary |
| --- | --- | --- |
| `gpt-5.6-luna` | Bounded high-throughput evidence work: search, extraction, exact anchors, log/DB inspection, mechanical checks, and short evidence-led investigations. Start at `reasoning_effort=low` unless the concrete contract needs more. | It may return a bounded finding from direct evidence, but not own architecture, broad synthesis, shared edits, or an absence verdict. Prompts need scope, `output_cap`, and `stop_condition`, not an artificially tiny one-file slice. |
| `gpt-5.6-terra` | Absolute daily default: multi-hop traces, root-cause diagnosis, research/config/test synthesis, normal implementation, review preparation, and verification. Start at `reasoning_effort=medium`. | Choose lower effort for straightforward mechanical work and higher only when evidence shows a need. Escalate to Sol only when the decision itself is highest risk or requires independent adversarial judgment. |
| `gpt-5.6-sol` | Highest-level lane: hardest ambiguous architecture, security, live-money/destructive decisions, adversarial critique, and final approval. | Never inherit it as a default, and do not use it for ordinary investigation, implementation, review preparation, or locating. Do not pair it with native `agent_type=explorer`. |

Route by output contract, risk, and context-state depth, not by role name or complexity adjectives. Luna can own a bounded rapid investigation that returns evidence and a direct finding; Terra is the default reasoning-capable child choice; Sol is an exception for the hardest independent judgment.

For broad, compiled, vendor, log-heavy, DB-heavy, or large-context repos, give Luna bounded evidence slices and mechanical checks, then use Terra for normal synthesis and implementation. If a Luna lane compacts, reduce the slice or move the synthesis to Terra; do not conclude that Luna cannot investigate. If any model hits remote compact context-window exhaustion, treat that as a runtime compact boundary for that model, not a model-family verdict.

When Codex emits `PreToolUse` for a spawn operation, the hook blocks every spawn that omits an explicit route, all native `fork_context=true` calls, configured native explorer shapes paired with Sol, capacity collisions that would hit the 6-lane runtime cap, and shell attempts to launch a detached `codex exec` worker. It does not block special native `agent_type` values only because they are special; Codex runtime owns that availability. Current Codex Desktop native `spawn_agent` paths may bypass that hard-block event, so the durable rule still belongs in `AGENTS.md` and the live transcript check.

Do not infer a native `agent_type` from a semantic role. When the actual tool requires a type, use its documented accepted value in the one intended explicit-model call. A runtime rejection is evidence that the constructed call is wrong; repair the source contract before a later attempt rather than probing alternate types or worker tools.

See [Delegation Control Implementation Plan](docs/delegation-control-implementation-plan.md) for the approved follow-up design that keeps the hook small while moving durable delegation policy into `AGENTS.md`.

## Design Basis

This project follows OpenAI's public agent guidance rather than a local complexity heuristic:

- Codex subagents are recommended for independent read-heavy work such as exploration, tests, triage, and summarization, while write-heavy parallelism needs more care: <https://developers.openai.com/codex/concepts/subagents>
- Codex model choice should vary by role and reasoning need: Luna for bounded evidence extraction, Terra for ordinary engineering judgment, and Sol for the highest-risk or most ambiguous frontier decisions.
- Agents SDK guidance recommends explicit per-agent model selection and mixed model sizes when fast triage agents and deeper specialists coexist: <https://developers.openai.com/api/docs/guides/agents/models>
- Community reports about large repos and context compaction point in the same direction: use cheaper/faster subagents for exploration and summarization, but keep synthesis and final judgment bounded and observable.

## Configuration

Create `$CODEX_HOME/native-agent-pool-advisor.config.json` when your Codex install needs a different fallback cap or a different native state DB name. The non-fork model family is fixed to Luna, Terra, and Sol.
If only `models.explorer` is set, the first model is treated as the scout guidance model and the second as the default fallback guidance model. This is prompt guidance only; it is not an `agent_type` allow-list.

```json
{
  "models": {
    "explorer": ["gpt-5.6-luna", "gpt-5.6-terra"],
    "explorerPreferred": "gpt-5.6-luna",
    "explorerFallback": "gpt-5.6-terra",
    "explorerForbidden": ["gpt-5.6-sol"],
    "allowedAgentTypes": ["default"]
  },
  "defaults": {
    "agentCap": 6,
    "warnRemaining": 1
  },
  "paths": {
    "stateDbName": "state_5.sqlite"
  }
}
```

Environment overrides are also supported:

- `NATIVE_AGENT_POOL_EXPLORER_MODELS`: comma-separated compatibility shortcut for scout/default guidance models. This does not create an `agent_type` allow-list; omitted model is still invalid, and is blocked when Codex emits a supported `PreToolUse` event for the spawn path.
- `NATIVE_AGENT_POOL_EXPLORER_MODEL`: preferred explorer model.
- `NATIVE_AGENT_POOL_EXPLORER_FALLBACK_MODEL`: fallback explorer model.
- `NATIVE_AGENT_POOL_EXPLORER_FORBIDDEN_MODELS`: comma-separated models that must not be paired with native `agent_type=explorer` if you explicitly allow that native type; defaults to `gpt-5.6-sol`.
- `NATIVE_AGENT_POOL_ALLOWED_AGENT_TYPES`: optional comma-separated native runtime `agent_type` allow-list for local diagnostic policy; defaults to no restriction. This is intentionally not a semantic role catalog, and an unset/empty value lets Codex runtime own special-type availability.
- `NATIVE_AGENT_POOL_DEFAULT_CAP`: fallback cap when `[agents].max_threads` is absent.
- `NATIVE_AGENT_POOL_WARN_REMAINING`: advisory threshold near the cap.
- `NATIVE_AGENT_POOL_STATE_DB_PATH` or `NATIVE_AGENT_POOL_STATE_DB_NAME`: native DB override.
- `NATIVE_AGENT_POOL_CLOSED_EDGE_RETENTION_HOURS`: retention for `closed` `thread_spawn_edges` maintenance; defaults to 168 hours. Maintenance runs at most every 6 hours and deletes only expired `closed` rows, in bounded batches.
- `NATIVE_AGENT_POOL_STALE_OPEN_EDGE_RETENTION_HOURS`: optional retention for repairing old current-parent `open` rows whose child thread has not updated within the configured window. Defaults to `0`, meaning disabled. This is for stale DB debt, not normal lane lifecycle management.

## Update

```bash
git pull
npm test
node scripts/install.mjs
node scripts/doctor.mjs
```

## Uninstall

```bash
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

Use `--remove-hook-file` only if no other local process references `~/.codex/hooks/native-agent-pool-advisor.mjs`.

## Explicit Pool Reset

Use reset only when the native edge table is known to contain stale rows that no current parent can close.

Danger: `reset-pool.mjs` deletes rows from Codex's `thread_spawn_edges` table. Always run `--dry-run` first. A reset creates a timestamped backup of `state_5.sqlite`; keep that backup until a fresh Codex session has proven the pool budget is healthy.

```bash
node scripts/reset-pool.mjs --parent <parent_thread_id> --dry-run
node scripts/reset-pool.mjs --parent <parent_thread_id> --force <force_token_from_dry_run>
```

`--global` exists for full reset events and requires both a matching dry-run token and explicit confirmation:

```bash
node scripts/reset-pool.mjs --global --dry-run
node scripts/reset-pool.mjs --global --confirm-global-reset --force <force_token_from_dry_run>
```

The script backs up `state_5.sqlite`, deletes matching `thread_spawn_edges`, writes a reset marker into `state/native-agent-pool-advisor.json`, and appends an audit log entry.

Restore is manual: stop Codex, replace `~/.codex/state_5.sqlite` with the backup path printed by the reset command, then restart Codex.

## Verification

```bash
npm run check
npm test
```

The test suite covers hook-script behavior: state-independent native spawn admission and over-budget blocking, explicit model enforcement when `PreToolUse` is emitted, strict model/fork shape normalization, reset-aware lifecycle transcript fallback, close-agent release semantics, explicit reset markers, and live-transcript bypass detection.

For real end-to-end evidence from Codex Desktop or CLI, inspect the actual parent transcript after a spawn attempt:

```bash
node scripts/live-check.mjs --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl
```

`ok=false` means the real transcript contains a native spawn path that was not protected before the child was created, a spawn call returned a runtime/tool failure such as pool exhaustion or invalid fork/model shape, a nested wrapper spawn could not be matched to output evidence, or a required close/model/open-count expectation failed. That is a runtime-boundary failure, not a passing hook test.

Use explicit expectations when validating a real run:

```bash
# Model routing: each tool input model must match the native DB model.
node scripts/live-check.mjs \
  --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl \
  --since-line <line_before_test> \
  --forbid-explorer-model gpt-5.6-sol \
  --allow-agent-type default \
  --expect-model gpt-5.6-luna \
  --expect-model gpt-5.6-terra \
  --expect-model gpt-5.6-sol \
  --expect-current-open 0 \
  --expect-all-closed \
  --allow-missing-guidance

# Capacity: six still-open child lanes without task_complete evidence occupy six slots.
node scripts/live-check.mjs \
  --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl \
  --since-line <line_before_capacity_test> \
  --expect-model gpt-5.6-luna \
  --expect-current-open 6 \
  --allow-missing-guidance
```

The live-check JSON includes `current_parent_lanes` with status, role, model, reasoning effort, nickname, title, and `updated_at` for offline diagnosis. Runtime hook prompt guidance intentionally omits titles/task prompts to avoid re-injecting stale child instructions into the parent context. Use the live-check block when validating lane reuse, completed-not-closed pressure, or close accounting.

`--allow-agent-type` enables an optional audit allow-list for installs that want to flag unexpected native `agent_type` values. By default there is no live-check agent-type restriction; runtime owns availability. This option is diagnostic and must not be confused with capacity admission.

At `open=6`, a live `UserPromptSubmit` hook run for that parent should emit `SPAWN_AGENT_DISABLED_THIS_TURN=true`, `occupied=6/6`, `observed_free=0`, and `remaining_spawn_budget=0`. Do not prove this by launching a seventh child; that recreates the waste this project is designed to prevent. If a later close succeeds, run a fresh hook/live check and use the updated observed snapshot instead of the stale zero-budget prompt.

## Known Limits

- This hook is intentionally fail-open on unexpected internal errors so it does not break ordinary Codex tool execution. Hard blocking only exists on hook events Codex actually emits for that tool path.
- Official Codex hook documentation currently documents `PreToolUse` support for Bash, `apply_patch`, and MCP tool names. Native `spawn_agent` hard-block coverage is not a documented capability. If a Codex Desktop or CLI spawn surface bypasses `PreToolUse`, the hook cannot block it in-process; `SessionStart`/`UserPromptSubmit`/`PreCompact`/`PostCompact` guidance and `PostToolUse` reconciliation are the fallback. `PreCompact` warns that remote compact can still fail at the current model's context boundary and cannot be repaired by more prompt/tool output in the same thread; `PostCompact` is especially important after successful compaction, when earlier spawn-shape guidance can disappear before the next delegation-heavy turn.
- Historical `hooks.json` backups and setup restore paths can replay old hook stacks. See `docs/runtime-audit.md`.
- This hook is a launch/capacity guard, not a delegation decision maker.

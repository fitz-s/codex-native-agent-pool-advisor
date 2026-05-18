# Codex Native Agent Pool Advisor

Guardrail hook for Codex native subagents in Codex Desktop and Codex CLI installs that use the shared `~/.codex` hook/state runtime. It prevents the recurring failure mode where an agent spends a long prompt on a new reviewer/verifier/explorer, hits the six-subagent native pool cap, then burns more context and attention closing old lanes and retrying.

Project page: <https://fitz-s.github.io/codex-native-agent-pool-advisor/>

## What Problem It Solves

Codex can delegate work to native subagents, but the pool limit is easy for the model to lose track of during long tasks. The expensive failure looks like this:

1. The leader writes a detailed child-agent prompt.
2. Runtime rejects the spawn because the native pool is already full.
3. The leader explains the failure, closes several agents, restates the prompt, or tries a different batch.
4. The thread loses context budget and attention before any useful review, verification, or exploration happens.

This hook makes that category of waste visible and harder to repeat. It injects the current parent/session budget, blocks spawns that are already doomed by capacity, rejects child-agent recursion at tool time, treats successful `close_agent` as the only normal slot release, and separates capped runtime slot pressure from stale or unresolved `open` edge debt.

Model routing is secondary but explicit. The hook requires every subagent spawn to include a deliberate model choice, with mini as the default when there is no stronger reason. That prevents accidental inheritance of the parent frontier model while still letting the leader choose Spark for scout work or 5.5 for critic/high-risk work.

## Compatibility

- Works with Codex Desktop and Codex CLI when they read the same `~/.codex/hooks.json`, hook events, and native SQLite state layout.
- Uses `CODEX_HOME` when set; otherwise defaults to `~/.codex`.
- Reads native pool state from `state_5.sqlite` by default. Override the DB name/path if a Codex build moves it.
- Installs for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`; run `node scripts/doctor.mjs` after install to confirm the active runtime is actually using this hook.

## Runtime Model

- Spawn admission is scoped to the current parent/session. The advisor reads native `thread_spawn_edges` rows where `parent_thread_id` matches the current parent thread; rows from other parent sessions do not affect this turn's budget.
- There is no global runtime pool counter in normal admission. Global reset tools are operator repair surfaces for stale state, not spawn-budget authority.
- Native cap comes from `~/.codex/config.toml` `[agents].max_threads`, defaulting to 6.
- `occupied` is a saturated current-parent slot estimate and is never reported above the cap. Extra current-parent `open` rows are surfaced separately as `unresolved_open_edges` and `open_edge_overflow`.
- Successful `spawn_agent` consumes a slot; a capacity-failed spawn consumes no new slot but sets pressure to full.
- `wait_agent`, `task_complete`, child completion notifications, and `send_input` never free a native slot.
- A completed child can still occupy the current parent pool until `close_agent` succeeds. Completed `open` rows are current-parent close/reset candidates, not proof of more than six live slots.
- The hook only decrements and mutates Codex SQLite on exact successful `PostToolUse(close_agent)` evidence for the current parent/session. Failed close attempts do not free capacity.
- If the current parent has an empty readable `thread_spawn_edges` slice, its native budget is empty. Historical transcript fallback is used only when native current-parent evidence is unavailable, not to import other sessions' slots.
- Child sessions do not receive proactive prompt-time delegation guidance. A child that attempts `spawn_agent` is blocked at `PreToolUse` and should report the need upward to its parent leader.
- Every `spawn_agent` call must include an explicit `model`. Omitted model means inherited parent model, and that is blocked when the hook sees the spawn.
- The default subagent choice is `gpt-5.4-mini` unless the leader has a stronger reason. Use `gpt-5.3-codex-spark` for fast read-only scout/probe/grep-style evidence collection. Use `gpt-5.5` only for critic, architecture, security, high-risk implementation, or final approval.
- Explorer model allow-list defaults to `gpt-5.3-codex-spark,gpt-5.4-mini`, so lookup lanes cannot silently spend `gpt-5.5`.
- The hook does not block Spark because a prompt looks "complex"; it emits contract guidance and lets the parent agent choose.
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

The installer copies `hooks/native-agent-pool-advisor.mjs` to `$CODEX_HOME/hooks/` and registers it for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`.

The installer is idempotent: repeated installs should leave one registration per hook event.

## Mandatory Model Selection

The capacity guard does not decide whether Codex should delegate. If the leader has already chosen to spawn, the hook requires the leader to make the model-selection judgment explicit instead of inheriting the parent model by accident.

| Model lane | Use for | Boundary |
| --- | --- | --- |
| `gpt-5.3-codex-spark` | Near-instant scout work: grep/file maps, symbol lookup, log filtering, candidate file:line anchors, hypothesis sampling, bounded large-text scans, and fast evidence collection inside larger reasoning workflows. Usually `reasoning_effort=low`, but non-low effort is allowed when intentional. | Do not ask it to own final approval, broad synthesis, edits, or repeated compaction. If the task expands, it should stop and return anchors plus an escalation recommendation. |
| `gpt-5.4-mini` | Default subagent lane; reasoning explorer / light executor work: multi-hop code-path traces, semantic classification, config+test synthesis, small low-risk fixes, compact evidence reports, and bounded verification that needs a durable conclusion. Use `reasoning_effort=medium` or `high` when judgment matters. | Not the default for disposable grep if Spark is available. Do not use as final authority for architecture, security, live-money, or high-risk implementation. |
| `gpt-5.5` | Critic, architecture, security judgment, high-risk implementation, and final approval. | Do not use for ordinary explorer/scout lanes or broad grep/file scans. |

Route by output contract, risk, and context-state depth, not by complexity adjectives. A complex parent task can use Spark well if the child prompt asks for bounded scout output such as "return 12 file:line anchors and stop." A mini lane is better when the child owns synthesis, a small edit, or a durable low-risk verification result.

The hook blocks any spawn that omits `model`, because inheritance is exactly the failure mode. It still blocks explorer spawns that choose a model outside the configured explorer allow-list, and only advises when a Spark or mini prompt looks mismatched to the lane.

## Design Basis

This project follows OpenAI's public agent guidance rather than a local complexity heuristic:

- Codex subagents are recommended for independent read-heavy work such as exploration, tests, triage, and summarization, while write-heavy parallelism needs more care: <https://developers.openai.com/codex/concepts/subagents>
- Codex model choice should vary by agent role and reasoning need. The same page describes `gpt-5.4-mini` as a fast, efficient choice for exploration, large-file review, and parallel workers, and `gpt-5.3-codex-spark` as a low-latency research-preview option.
- Agents SDK guidance recommends explicit per-agent model selection and mixed model sizes when fast triage agents and deeper specialists coexist: <https://developers.openai.com/api/docs/guides/agents/models>
- Community reports about large repos and context compaction point in the same direction: use cheaper/faster subagents for exploration and summarization, but keep synthesis and final judgment bounded and observable.

## Configuration

Create `$CODEX_HOME/native-agent-pool-advisor.config.json` when your Codex install uses different model names, a different fallback cap, or a different native state DB name.
If only `models.explorer` is set, the first model is treated as preferred and the second as fallback.

```json
{
  "models": {
    "explorer": ["gpt-5.3-codex-spark", "gpt-5.4-mini"],
    "explorerPreferred": "gpt-5.3-codex-spark",
    "explorerFallback": "gpt-5.4-mini"
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

- `NATIVE_AGENT_POOL_EXPLORER_MODELS`: comma-separated explorer allow-list. This does not change the global default: omitted model is still blocked, and the leader should explicitly choose mini when unsure.
- `NATIVE_AGENT_POOL_EXPLORER_MODEL`: preferred explorer model.
- `NATIVE_AGENT_POOL_EXPLORER_FALLBACK_MODEL`: fallback explorer model.
- `NATIVE_AGENT_POOL_DEFAULT_CAP`: fallback cap when `[agents].max_threads` is absent.
- `NATIVE_AGENT_POOL_WARN_REMAINING`: advisory threshold near the cap.
- `NATIVE_AGENT_POOL_STATE_DB_PATH` or `NATIVE_AGENT_POOL_STATE_DB_NAME`: native DB override.

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

The test suite covers wrapper-spawn blocking, universal explicit model enforcement, explorer allow-list enforcement, advisory-only Spark/mini contract routing, reset-aware transcript fallback, close-agent release semantics, and explicit reset markers.

## Known Limits

- This hook is intentionally fail-open on unexpected internal errors so it does not break ordinary Codex tool execution. It blocks only when it has enough state to identify an unsafe spawn, a recursive child spawn, a lock/contention risk, or a model-route violation.
- If a Codex Desktop or CLI spawn surface bypasses `PreToolUse` entirely, the hook cannot block it in-process; `SessionStart`/`UserPromptSubmit` guidance and `PostToolUse` reconciliation are the fallback. `SessionStart` is especially important after compaction/resume, when a model may continue work without a fresh user prompt.
- Historical `hooks.json` backups and setup restore paths can replay old hook stacks. See `docs/runtime-audit.md`.
- This hook is a launch/capacity guard, not a delegation decision maker.

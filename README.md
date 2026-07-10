# Native Agent Admission Guard

This project keeps Codex native child dispatch inside four hard boundaries:

1. Child model and `reasoning_effort` are selected per task, explicitly.
2. A real `PreToolUse(spawn_agent)` event reads only the current parent's native edges and blocks a batch that exceeds `[agents].max_threads` (six by default).
3. `close_agent` accepts only an exact current-parent open child ID.
4. The guard never creates, closes, archives, repairs, resets, or otherwise writes Codex's SQLite state.

It is intentionally not an agent orchestrator. Codex runtime owns lifecycle and capacity. The guard is a read-only admission check when the runtime exposes a supported hook event, plus transcript hygiene for legacy failed-lane narration.

## Routing

Every non-fork child dispatch must carry both fields explicitly:

```text
model: gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-sol
reasoning_effort: low | medium | high | xhigh
```

Choose them from the actual task, not the parent, role, tier, or a default matrix.

| Model | Appropriate work |
| --- | --- |
| `gpt-5.6-luna` | Bounded search, extraction, exact anchors, logs/DB inspection, and mechanical checks. |
| `gpt-5.6-terra` | General tracing, implementation, debugging, verification, and synthesis. |
| `gpt-5.6-sol` | Hardest judgment: ambiguous architecture, security, destructive/live-money decisions, and adversarial critique. |

`agent_type` is transport metadata only. It never chooses or restricts model or effort. A role named `explorer` may use Sol when the task warrants it.

`fork_context=true` is blocked because it inherits the parent route. A rejected dispatch is a source-contract error: repair the intended call, not by trying alternate agent types, a legacy continuation tool, or `codex exec` fallback.

## Installation

```bash
npm test
node scripts/install.mjs
node scripts/doctor.mjs
```

The installer registers the hook only for:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostCompact`

It retires the former global-state watcher: a launchd process that fabricated `PreToolUse` every 500ms. Retired watcher files and plist are renamed with `.disabled-...`; they are not deleted.

`SessionStart`, prompt submission, and compaction only remove assistant-origin legacy status records such as failed `followup_task` lanes and `live agent path ... not found`. They emit no capacity narrative. This keeps a failed dispatch from becoming fresh parent context while preserving user text and normal evidence.

## Runtime Limits

Codex does not document native `spawn_agent` as a universal `PreToolUse` target. When the event is absent, this hook cannot silently emulate admission with a lock, transcript parser, local reservation, watcher, or DB mutation. The only truthful result is that live routing must be validated after the fact.

Use the read-only verifier on a real transcript:

```bash
node scripts/live-check.mjs \
  --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl \
  --expect-model gpt-5.6-terra
```

It fails on missing explicit route fields, inherited forks, runtime spawn failures, native DB route mismatches, and legacy `followup_task` failures. It does not message, close, or start children.

## DB Policy

`state_5.sqlite` is a Codex-owned authority and is read-only to this project. In particular, a `not found` close result does **not** prove a lane is gone and never frees a slot here.

`scripts/reset-pool.mjs` remains only as a read-only edge inspector for operational diagnosis:

```bash
node scripts/reset-pool.mjs --parent <parent_thread_id>
```

No DB backup, copy, archive, repair, or reset is created by this project.

## Verification

```bash
npm run check
npm test
```

The tests cover explicit route selection, role-independent Sol use, batch admission, exact-ID close validation, no SQLite mutation after `not found`, transcript hygiene, watcher retirement, and read-only inspection.

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
- `SubagentStop`

It retires the former global-state watcher: a launchd process that fabricated `PreToolUse` every 500ms. Retired watcher files and plist are renamed with `.disabled-...`; they are not deleted.

The installer removes legacy global orchestration hooks and quarantines the
startup self-heal script that can restore them. `doctor` fails while either is
registered, so a later startup cannot silently reintroduce a second lifecycle
controller.

`SessionStart`, prompt submission, compaction, and `SubagentStop` only remove assistant-origin legacy status records such as failed `followup_task` lanes and `live agent path ... not found`. They emit no capacity narrative. This keeps a failed dispatch from becoming fresh parent context while preserving user text and normal evidence.

## Releasing Completed Subagents

Completion is not release. `wait_agent` or a returned result only means the
work is available to summarize. When the result has been integrated and the
thread will receive no more follow-up, ask Codex to close the completed
subagent thread. [Codex documents this as an orchestration responsibility](https://learn.chatgpt.com/docs/agent-configuration/subagents#orchestration-and-thread-controls); the
guard does not reimplement it. Codex owns that action and emits the lifecycle result; the
guard only permits a `close_agent` call that names an exact current-parent open
child ID.

Do not close by nickname, title, quoted status text, inferred path, or a stale
transcript ID. A `not found` result is not release evidence: do not retry,
spawn a replacement, or mutate SQLite. Inspect the subagent activity and let
Codex reconcile its own thread state. `SubagentStop` is used only to sanitize
completed-thread residue after the runtime reports the stop.

## Runtime Limits

Codex does not document native `spawn_agent` as a universal `PreToolUse` target. When the event is absent, this hook cannot silently emulate admission with a lock, transcript parser, local reservation, watcher, or DB mutation. The only truthful result is that live routing must be validated after the fact.

Use the read-only verifier on a real transcript:

```bash
node scripts/live-check.mjs \
  --transcript ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl \
  --expect-model gpt-5.6-terra
```

It parses both direct native calls and the current `functions.exec` wrapper used
by `multi_agent_v1`. It fails on missing explicit route fields, inherited forks,
unattributed embedded calls, runtime spawn failures, native DB route mismatches,
and legacy `followup_task` failures. It does not message, close, or start children.

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

The tests cover explicit route selection, role-independent Sol use, batch admission, exact-ID close validation, no SQLite mutation after `not found`, transcript hygiene, legacy-hook retirement, embedded route-mismatch detection, and read-only inspection.

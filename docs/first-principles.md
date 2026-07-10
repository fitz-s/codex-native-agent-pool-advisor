# First Principles

## Authority

Codex runtime owns child creation, lifecycle, and `thread_spawn_edges`. A hook can observe a documented event; it cannot become a second scheduler.

Therefore this project never:

- creates a child or calls a continuation lane;
- closes a child from inferred text, nickname, title, or stale ID;
- writes `thread_spawn_edges` or `threads`;
- creates local slot reservations, stale-edge repair, DB backups, or reset markers;
- runs a watcher that fabricates hook events.

## Admission

When, and only when, the runtime emits `PreToolUse` for native `spawn_agent`, the hook reads current-parent non-closed `thread_spawn_edges` in read-only mode. It blocks:

- missing or unsupported explicit `model`;
- missing or unsupported explicit `reasoning_effort`;
- `fork_context=true` inheritance;
- a same-call batch whose count plus current-parent open edges exceeds the configured cap;
- a close target that is not an exact current-parent open child ID;
- `codex exec` used as an unsupported child-dispatch fallback.

The check is parent-scoped. Rows belonging to another parent do not consume this parent's budget.

## Routing

The parent chooses model and effort independently for each task. Roles describe responsibility only.

- Luna: bounded evidence.
- Terra: general engineering.
- Sol: hardest independent judgment.

No role, capability name, parent setting, or project default selects either field. A dispatch surface without both fields is not dynamically routed.

## Context Hygiene

Legacy assistant messages can claim an unavailable lane was started or closed, then a failed `followup_task` writes `live agent path ... not found`. Those records are operational residue, not task evidence. On normal context events the hook removes only those assistant-origin records and their paired failed calls. User messages and normal verification evidence remain intact.

## Proof

Hook tests prove local behavior. `live-check` verifies the transcript and native rows from a real runtime session. Because native spawn interception is not universally documented, a passing unit test is not proof that every Codex surface emitted `PreToolUse`.

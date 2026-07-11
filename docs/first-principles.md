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

Wrapped `functions.exec` native calls are part of the same boundary. Static
`multi_agent_v1__spawn_agent` and `close_agent` object literals are parsed before
execution; a dynamic object is blocked because its route or close authority
cannot be proved at admission time.

The check is parent-scoped. Rows belonging to another parent do not consume this parent's budget.

## Release

Codex owns release. A parent first waits for or receives the child's result,
integrates it, then asks Codex to close that completed thread when no follow-up
is needed. Completion, `wait_agent`, and a missing target are not interchangeable
with release.

If the runtime presents `close_agent`, the guard accepts only an exact
current-parent open child ID. It never derives a target from a nickname, title,
quoted status, path, or transcript history. `not found` is a runtime discrepancy
to inspect in Codex, never permission to retry, free capacity, or change SQLite.
`SubagentStop` is a runtime event for hygiene and audit, not an instruction to
close another thread.

## Routing

The parent chooses model family and effort independently for each task. The native dispatcher prefers the parent's route even when those two call fields are present, so an installed custom configuration layer is required to make the model selection effective.

The three registered builtin types are dedicated route carriers:

- `explorer` fixes Luna for bounded evidence.
- `worker` fixes Terra for general engineering.
- `default` fixes Sol for hardest independent judgment.

The task message alone names the child's responsibility. A carrier name is not a role decision. Every dispatch still passes the carrier's matching `model` plus task-selected `reasoning_effort`. The hook requires that effort to be explicit but leaves catalog acceptance to the live runtime, then `live-check` compares the persisted child route with the request.

This is intentionally three profiles, not a role-by-model matrix or one profile per effort. The profile supplies the model layer that the runtime honors; effort remains an explicit per-child choice.

## Context Hygiene

Legacy assistant messages can claim an unavailable lane was started or closed, then a failed `followup_task` writes `live agent path ... not found`. Those records are operational residue, not task evidence. On normal context events the hook removes only those assistant-origin records and their paired failed calls. User messages and normal verification evidence remain intact.

## Proof

Hook tests prove local behavior. `live-check` verifies the transcript and native rows from a real runtime session. Because native spawn interception is not universally documented, a passing unit test is not proof that every Codex surface emitted `PreToolUse`.

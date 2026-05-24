# First-Principles Design

## Original Goal

The goal is not to make Codex use fewer subagents. The goal is to keep Codex's main thread focused while preventing this waste pattern:

1. The parent agent writes a long child prompt.
2. Native runtime rejects the spawn because the six-slot pool is full.
3. The parent spends more context explaining the miss, closing lanes, and restating prompts.
4. The user pays context, token, and attention cost before any useful child work happens.

The correct system preserves subagents as context-isolation lanes while making failed spawns, accidental frontier-model inheritance, and disposable lane churn harder to repeat.

It must also avoid the opposite drift: a leader that treats hook safety text as a reason to do all read-heavy work in the main thread. For subagent-relevant work, the leader should explicitly choose one path: reuse a compatible lane, spawn one lane and resample capacity, or stay local because the task is tiny, urgent, user-forbidden, or blocked on evidence already being collected.

## Codex Runtime Boundaries

- Capacity is per parent/session, not global.
- The native cap is six by default via `[agents].max_threads`.
- A completed child can still occupy a native slot until `close_agent` succeeds or verified not-found/stale-completed repair closes the edge.
- `wait_agent` and `send_input` do not free capacity.
- There is no atomic reservation primitive for multi-spawn batches.
- Current Codex hook documentation does not make native `spawn_agent` a guaranteed `PreToolUse` hard-block surface.
- Omitted subagent `model` can inherit the parent model. That is unacceptable for predictable model routing.

## Structural Solution

1. Capacity oracle:
   - Read current-parent native `thread_spawn_edges`.
   - Saturate occupied count at the native cap.
   - Treat overflow as repair debt, not more live agents.
   - Ignore other parents for admission.
   - Repair stale `task_complete` open edges.

2. Launch protocol:
   - Treat `observed_free` as a snapshot, not a batch reservation.
   - Block multi-spawn batches on supported hook surfaces.
   - Launch at most one child, then resample.
   - After any capacity failure, stop spawning until close/repair/reset produces a newer snapshot.
   - Keep positive-budget guidance short unless there is zero budget, unreadable native state, invalid spawn shape, current-parent lane pressure, or narrow explicit spawn intent.
   - Apply explicit negative intent first. Phrases such as "do not spawn agents" or "no subagents" suppress prompt-triggered spawn guidance unless an actual spawn tool payload is visible.

3. Model boundary:
   - Every non-fork `spawn_agent` tool input must include a non-empty string `model`.
   - Boolean `fork_context=true` without `model` is the only inheritance exception.
   - `agent_type` is never the semantic model-routing authority, and semantic roles are not automatically native runtime shapes.
   - Use native `agent_type=default` for researcher/critic/verifier/architect-style semantic roles; put the role in message/title/task contract and choose `model` explicitly.
   - `agent_type=explorer` with a forbidden frontier model is invalid shape; use `agent_type=default` for frontier critic/architecture/high-risk lanes.
   - `live-check` must catch missing-model bypasses, unsupported native agent types, tool-model/native-model mismatches, and explorer/frontier role-shape violations.

4. Lane lifecycle:
   - Treat subagents as reusable context lanes.
   - Before spawning, compare the task contract to listed current-parent lanes.
   - Use `send_input` for same-topic compatible lanes.
   - A completed lane is reusable only inside the same active task/window when near-term follow-up is likely.
   - Close only stale, unrelated, wrong-model, capacity-needed, or active-task-complete lanes.
   - Never send recursive orchestration duties to child sessions.

This is the clean boundary: the hook enforces observable runtime facts and explicit spawn shape; the parent agent remains responsible for semantic model choice and same-topic reuse decisions.

# Delegation Control Implementation Plan

## Goal

Turn the native-agent guardrail from a collision-prevention hook into a small delegation control system:

- Preserve the leader agent's context by using subagents as reusable context lanes.
- Prevent six-slot native pool collisions before the leader spends a long child prompt.
- Prevent accidental frontier-model waste, especially explorer lanes using `gpt-5.5`.
- Prevent the opposite failure where the leader avoids useful subagents because the safety guidance feels too risky or noisy.

This plan does not make the hook decide whether delegation is semantically needed. It separates safety enforcement, delegation policy, lane lifecycle, and live audit into different artifacts.

## Current Failure Modes

1. Over-delegation after prompt priming:
   - The leader sees subagent guidance and spawns aggressively.
   - It may overuse frontier models because "complex" or "high risk" is treated as a model choice.
   - Result: slot churn, high context/token spend, and weaker integration.

2. Disposable lane churn:
   - The leader spawns one child, waits, then closes it immediately.
   - This preserves slot count but destroys the main benefit of native subagents: retained topic context.
   - Result: repeated rehydration and duplicated child prompts.

3. Silent under-delegation:
   - The hook guidance is long and penalty-shaped.
   - The leader learns "spawning is dangerous" and keeps large read-heavy work in the main context.
   - Result: main-context pollution and poorer parallel throughput.

These are not three independent bugs. They are symptoms of mixing four responsibilities into one hook: safety gate, delegation teacher, lane scheduler, and audit system.

## Codex Runtime Constraints

- Native subagent capacity is per parent/session, with a six-slot default cap.
- A completed child can still occupy a slot until `close_agent` succeeds or verified stale/not-found repair closes the current-parent edge.
- There is no atomic runtime reservation API for multi-spawn batches.
- `observed_free` is a current snapshot, not permission to batch-spawn that many children.
- `wait_agent` and `send_input` do not free capacity.
- Current Codex hook surfaces may not hard-block every native `spawn_agent` path with `PreToolUse`.
- `fork_context=true` may require omitted `model`, so it is an explicit full-history inheritance exception.
- Child agents must not recursively spawn; they report escalation needs upward.

## Target Architecture

### Layer 1: Safety Gate

Owner: `hooks/native-agent-pool-advisor.mjs`.

Responsibilities:

- Count current-parent native capacity from authoritative native edges when available.
- Repair stale `open` edges with child `task_complete` evidence.
- Block or warn on observable hard errors:
  - child-session recursive spawn;
  - unscoped spawn hook payload;
  - missing non-fork `model`;
  - `fork_context=true` plus explicit `model`;
  - unsupported native `agent_type` values, because OMX/prompt semantic roles such as `researcher` should be message/title text on `agent_type=default` unless this exact runtime has successful live spawn evidence for them;
  - `agent_type=explorer` plus forbidden frontier model;
  - observed pending same-turn spawn attempt debt with TTL, using the existing `SPAWN_RESERVATION_TTL_MS` default unless renamed during implementation;
  - multi-spawn batch without runtime reservation;
  - zero free slots or unreadable native edge state.
- Keep ordinary positive-budget guidance short.

Non-responsibilities:

- Do not decide whether subagents are useful.
- Do not choose the model from prose semantics.
- Do not tell child agents to orchestrate.
- Do not recommend immediate close when capacity is not under pressure.

### Layer 2: Delegation Policy

Owner: root `~/.codex/AGENTS.md`, mirrored in public docs.

Responsibilities:

- Provide a compact decision protocol the leader can apply before spawning:
  1. Delegate only when the subtask is independent, bounded, and reduces main-context load or runs in parallel without blocking the next local step.
  2. Reuse a same-topic compatible lane before spawning.
  3. Choose model from output contract, risk, state depth, and edit permission.
  4. Launch at most one child, then resample capacity before launching another.
- Make "no subagent" an explicit decision for subagent-relevant work:
  - Explicit user instructions such as "do not spawn agents" always win.
  - If the task is read-heavy, multi-slice, or explicitly asks for parallel work, the leader should either spawn/reuse or briefly state why it stays local.
  - Do not require that explanation for tiny tasks, urgent blockers, small local reads, or tasks whose next local action is blocked on the same evidence.

### Layer 3: Lane Lifecycle

Owner: root `~/.codex/AGENTS.md`, hook lane inventory, and live-check.

Responsibilities:

- Treat subagents as reusable topic lanes.
- Keep a completed lane open only for the same active task/window when near-term follow-up on the same topic is likely.
- Prefer `send_input` when the lane has:
  - same repo/domain/topic;
  - compatible model and role;
  - useful prior context;
  - no conflicting edit ownership.
- Show lane age or `updated_at` in lane inventory so the parent can identify stale retained lanes without a background scheduler.
- Close only when:
  - the lane is stale or unrelated;
  - the lane has the wrong model/role for the next task;
  - a slot is needed for higher-value work;
  - free slots are under pressure, such as `observed_free <= 1`;
  - the active task/window is finished and no near-term follow-up is expected.

### Layer 4: Live Audit

Owner: `scripts/live-check.mjs`.

Responsibilities:

- Verify real transcripts, not only synthetic hook behavior.
- Detect:
  - missing-model child creation;
  - tool/native model mismatch;
  - explorer/frontier role-shape violation;
  - missing native edge evidence;
  - spawn output failures;
  - close release failures;
  - same-response spawn batches;
  - current-parent open count.
- Report root cause categories without masking evidence absence as model mismatch.

## Implementation Phases

### Phase A: Shrink Positive-Budget Hook Guidance

Problem: the hook currently emits long guidance even when `observed_free > 0` and no lane pressure exists. That creates attention drift.

Changes:

- Add a short positive-budget guidance mode:
  - one capacity line;
  - one model-shape line;
  - one lane-reuse line only when current-parent lanes exist.
- Emit long recovery guidance only when:
  - `observed_free=0`;
  - native edge state is unreadable;
  - spawn shape is invalid;
  - current-parent lanes exist and `LANE_REUSE_CHECK_REQUIRED=true`;
  - the prompt narrowly expresses spawn intent, such as `spawn_agent`, `subagent`, `child agent`, or explicit "start/launch/spawn an agent" wording.
- Apply explicit negative intent before keyword matching. Phrases such as "do not spawn", "no subagents", or "do not use agents" suppress prompt-triggered long guidance unless an actual spawn tool payload is visible.
- Do not use broad words like `review`, `research`, `verify`, or `parallel` by themselves as hook-side semantic classifiers. They are delegation-policy signals for the parent, not hook triggers.
- Keep machine-readable flags stable:
  - `SPAWN_AGENT_OBSERVED_FREE=<n>`;
  - `BATCH_SPAWN_GUARANTEE=false`;
  - `SUBAGENT_MODEL_SELECTION_REQUIRED=true` only when an actual spawn tool payload is visible, a narrow explicit spawn-intent prompt is detected, capacity is zero/unreadable, or current-parent lanes exist.

Tests:

- Positive budget, no lanes, no subagent prompt -> concise output.
- Positive budget, active lane inventory -> includes lane reuse digest.
- Zero budget -> includes recovery protocol.
- Invalid spawn shape -> includes block reason and corrected shape.
- False-positive control: `review this; do not spawn agents` -> concise output and no long model-routing lecture.
- Pending attempt TTL:
  - unexpired observed same-turn spawn attempt debt blocks or serializes a follow-up spawn;
  - expired attempt debt is pruned and does not block.

### Phase B: Add Delegation Decision Protocol Docs

Problem: the hook cannot safely teach the entire policy every turn.

Changes:

- Update repo docs (`README.md`, `docs/first-principles.md`, and this plan) with a short protocol:
  - `delegate?`
  - `reuse?`
  - `model/role?`
  - `spawn one and resample?`
  - `retain or close lane?`
- Remove wording that makes completion sound like a reason to close.
- Add a "no silent under-delegation" clause only for subagent-relevant work.
- Treat root `~/.codex/AGENTS.md` as a local deployment patch, not package source. If this machine is the target runtime, update it in a separate deployment step and verify it with direct file inspection.

Tests:

- Documentation grep checks for:
  - `completed lane is reusable`;
  - `close only when stale/wrong/cap-needed`;
  - `agent_type=default` for frontier critic lanes;
  - `Spark/mini` for explorer lanes.
- Local deployment check, outside package tests:
  - root `~/.codex/AGENTS.md` contains the same compact protocol;
  - no `/Users/AGENTS.md` or `/Users/leofitz/AGENTS.md` is created.

### Phase C: Lane Inventory and Reuse Signal Cleanup

Problem: lane reuse guidance is present, but it is buried inside long capacity text and can be misread as close-first behavior.

Changes:

- Format current-parent lane inventory as a compact digest:
  - `LANES_OPEN=<n>`;
  - `LANES_COMPLETED_NOT_CLOSED=<n>`;
  - `LANE_REUSE_CHECK_REQUIRED=true` only when there is at least one current-parent lane.
- For each lane, show:
  - child id prefix;
  - nickname;
  - role;
  - model;
  - title preview;
  - status.
  - `updated_at` or compact age.
- Remove "close candidates" framing from positive-budget prompts.
- Keep "close completed-not-closed candidates first" only in zero-budget recovery.

Tests:

- Completed lane plus positive budget -> reuse guidance, no close-first wording.
- Completed lane plus zero budget -> close/reuse/wait local recovery wording.
- Wrong-model lane -> listed as lane; parent policy decides whether to close.
- Stale completed lane -> inventory shows age; hook does not run a background scheduler or auto-close from age alone.

### Phase D: Model/Role Shape Hardening

Problem: explicit wrong model selection is different from omitted model inheritance.

Already implemented baseline:

- Block non-fork missing `model`.
- Block `agent_type=explorer` plus `gpt-5.5`.
- Allow frontier lanes as `agent_type=default`.
- Detect bypasses in `live-check`.

Additional changes:

- Move forbidden explorer models into a documented config surface.
- Add doc examples for correct frontier critic spawn shape.
- Add a live-check option:
  - `--forbid-explorer-model <model>` repeatable, defaulting to `gpt-5.5`.

Tests:

- Explorer plus forbidden model fails.
- Default plus frontier model passes.
- Spark/mini explorer passes.
- Missing native edge does not report model mismatch.

### Phase E: Live Runtime Verification Harness

Problem: synthetic tests cannot prove Codex Desktop/CLI emits every hook surface.

Changes:

- Add a release checklist section requiring live transcript verification for any claim about native spawn behavior.
- Add example commands for:
  - positive-budget short guidance;
  - explorer/frontier block;
  - real transcript violation detection;
  - zero-budget recovery guidance;
  - close not-found release evidence.
- Keep these checks read-only except install/doctor.

Tests:

- `npm run check`.
- `npm test`.
- `git diff --check`.
- Temporary install/doctor check:
  - `tmp=$(mktemp -d)`;
  - `CODEX_HOME="$tmp" node scripts/install.mjs`;
  - `sqlite3 "$tmp/state_5.sqlite" 'create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);'`;
  - `CODEX_HOME="$tmp" node scripts/doctor.mjs`.
- Live install remains an operator release/deployment step, not a package test.
- Read-only `live-check` against one known real transcript window.

## Expected Behavior After Implementation

1. Over-delegation is reduced:
   - Positive-budget hook output no longer feels like a broad command to spawn.
   - Multi-spawn remains blocked unless Codex gains atomic reservation semantics.
   - Frontier model cannot be hidden under `agent_type=explorer`.

2. Disposable lane churn is reduced:
   - Completed lanes are described as reusable context lanes, not cleanup debt.
   - Close-first guidance appears only under zero-budget or stale/wrong-topic conditions.

3. Silent under-delegation is reduced:
   - AGENTS policy says subagent-relevant read-heavy or multi-slice work must explicitly choose spawn, reuse, or local execution unless the user forbids spawning.
   - The hook stops scaring the leader with long positive-budget warnings.

## Non-Goals

- Do not build a global scheduler.
- Do not mutate Codex runtime internals beyond current SQLite repair rules.
- Do not infer task semantics from long prose inside the hook.
- Do not force subagent use for every analysis task.
- Do not make `agent_type` the semantic model router; only enforce invalid native role/model shapes and unsupported native runtime types.
- Do not ask child agents to manage slots or spawn recursively.

## Open Risks

- Codex may continue to bypass `PreToolUse` for some native spawn paths; live-check remains necessary.
- The hook cannot know whether two tasks are truly same-topic; lane reuse remains a parent decision.
- Shorter guidance may reduce reminders too much for older agent policies; root `AGENTS.md` must carry the stable protocol.
- If Codex adds atomic reservations later, Phase A/C sequencing rules should be revised.

## Success Criteria

- `live-check` reports `native_explorer_frontier_model_violation` for historical `agent_type=explorer` plus `gpt-5.5` transcripts, reports unsupported semantic native `agent_type` usage, and shows no such violation in a new controlled compliant transcript window.
- Positive-budget prompt guidance is materially shorter than zero-budget recovery guidance.
- Hook output includes a compact lane digest with role/model/status/age when current-parent lanes exist.
- Docs state completed lanes are reusable and should close only when stale, wrong-model/topic, cap-needed, or task-window complete.
- `live-check` reports current-parent open/completed lane evidence without requiring a behavioral pass/fail judgment about whether the leader voluntarily reused a lane.
- A manual transcript may be cited as evidence of lane reuse behavior, but it is not a deterministic pass/fail gate.
- `npm test`, `npm run check`, `git diff --check`, `doctor`, and at least one real `live-check` pass for the modified behavior.

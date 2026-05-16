# Codex Native Agent Pool Advisor

Guardrail hook for Codex Desktop native subagents. It keeps the parent-thread subagent budget visible, blocks capacity-collision spawns, blocks recursive child-agent spawning, and forces read-only explorer lanes onto `gpt-5.3-codex-spark`.

## Runtime Model

- Authority is per parent thread: `thread_spawn_edges.parent_thread_id`.
- Native cap comes from `~/.codex/config.toml` `[agents].max_threads`, defaulting to 6.
- `wait_agent` never frees a native slot.
- A completed child remains a reusable lane and still occupies a slot until `close_agent` succeeds.
- The hook only mutates Codex SQLite on exact successful `PostToolUse(close_agent)` evidence.
- Empty `thread_spawn_edges` is authoritative only after an explicit reset marker; otherwise transcript fallback prevents false-zero occupancy.

## Install

```bash
cd /Users/leofitz/codex-native-agent-pool-advisor
npm test
node scripts/install.mjs
```

The installer copies `hooks/native-agent-pool-advisor.mjs` to `~/.codex/hooks/` and registers it for `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`.

## Explicit Pool Reset

Use reset only when the native edge table is known to contain stale rows that no current parent can close.

```bash
node scripts/reset-pool.mjs --parent <parent_thread_id> --dry-run
node scripts/reset-pool.mjs --parent <parent_thread_id>
```

`--global` exists for full reset events. The script backs up `state_5.sqlite`, deletes matching `thread_spawn_edges`, writes a reset marker into `state/native-agent-pool-advisor.json`, and appends an audit log entry.

## Verification

```bash
npm run check
npm test
```

The test suite covers wrapper-spawn blocking, Spark route enforcement, reset-aware transcript fallback, close-agent release semantics, and explicit reset markers.

## Known Limits

- If a Codex spawn surface bypasses `PreToolUse` entirely, the hook cannot block it in-process; `UserPromptSubmit` guidance is the fallback.
- Historical `hooks.json` backups and setup restore paths can replay old hook stacks. See `docs/runtime-audit.md`.
- This hook is a launch/capacity guard, not a delegation decision maker.

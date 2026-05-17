# Runtime Audit

## Live Surfaces

- Active user hook config: `~/.codex/hooks.json`.
- Active advisor path: `~/.codex/hooks/native-agent-pool-advisor.mjs`.
- Advisor state: `~/.codex/state/native-agent-pool-advisor.json`.
- Optional advisor config: `~/.codex/native-agent-pool-advisor.config.json`.
- Native Desktop state: `~/.codex/state_5.sqlite`, especially `thread_spawn_edges`.
- Native cap: `~/.codex/config.toml` `[agents].max_threads`.

## Hidden Branches

- `~/.codex/hooks/quiet-omx-status-self-heal.mjs` runs on `SessionStart` and can normalize live hook registration.
- `~/.codex/hooks.json.backup.*` and `~/.codex/hooks.json.preprobe` contain older hook layouts and matchers.
- `~/.omx/backups/setup/**/.codex/hooks.json` can replay old setup-time hook stacks.
- `oh-my-codex` setup currently strips legacy `codex-native-hook.js` managed entries, but setup/restore behavior still depends on user-scope config and backups.
- Backup DBs such as `state_5.sqlite.backup-*` are not read by the advisor unless manually restored over `state_5.sqlite`.

## Theory vs Runtime Fixes

- Wrapper/nested tool calls are inspected for agent operations, so `multi_tool_use.parallel` cannot hide `spawn_agent`.
- Empty native-edge tables are not treated as current truth unless an explicit reset marker exists.
- Transcript and child-session fallback ignore events older than the reset marker.
- General evidence collection does not repair native edges. Only successful `PostToolUse(close_agent)` can mark a native edge closed.
- Wrapped `multi_tool_use.parallel` evidence is normalized before accounting, so nested `spawn_agent`, `wait_agent`, and `close_agent` calls update the same budget model as direct tool calls.
- Multiple `spawn_agent` calls inside one wrapper consume multiple requested slots before the hook decides whether to block.
- Explorer model routing is an allow-list plus advisory contract guidance, not a single hard-coded model and not a task-shape blocker. The default is Spark for near-instant scout/probe work plus mini for reasoning explorer / light executor work; installations can override model names in config or env.
- Complex explorer prompts on Spark are allowed when Spark is used as a bounded scout/anchor collector. The hook only advises the agent to cap scope/output or escalate synthesis/edit/final-approval follow-up to mini or a frontier reviewer.
- Current-session terminal lanes still consume local budget until `close_agent` succeeds.
- Native SQLite `open` edges whose child transcript has `task_complete` are stale terminal-open edges: they are excluded from occupied capacity and surfaced with explicit `close_agent target=<id>` or reset guidance.
- If the advisor state lock or native edge query is unavailable during `PreToolUse(spawn_agent)`, the hook blocks conservatively.
- Automatic hook maintenance does not prune Codex SQLite. SQLite mutation is limited to successful close-agent repair and the explicit reset tool.

## Remaining Risk

The hook cannot prove that every future Codex Desktop spawn path will emit `PreToolUse`. That is why `UserPromptSubmit` still injects budget guidance and why `spawn_agent` batching is discouraged even when the hook appears healthy.

The reset script intentionally mutates `thread_spawn_edges`. It should be treated as an operator repair command, not normal hook execution.

Reset is two-phase by design: dry-run computes the affected scope and a force token; mutation requires that token. Global reset also requires `--confirm-global-reset`.

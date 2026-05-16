# Runtime Audit

## Live Surfaces

- Active user hook config: `~/.codex/hooks.json`.
- Active advisor path: `~/.codex/hooks/native-agent-pool-advisor.mjs`.
- Advisor state: `~/.codex/state/native-agent-pool-advisor.json`.
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
- Terminal-open lanes are surfaced as reusable completed lanes with explicit `close_agent target=<id>` cleanup candidates.
- If the advisor state lock or native edge query is unavailable during `PreToolUse(spawn_agent)`, the hook blocks conservatively.

## Remaining Risk

The hook cannot prove that every future Codex Desktop spawn path will emit `PreToolUse`. That is why `UserPromptSubmit` still injects budget guidance and why `spawn_agent` batching is discouraged even when the hook appears healthy.

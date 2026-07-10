# Runtime Audit

Current acceptance criteria:

1. `node scripts/doctor.mjs` reports exactly one registration for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostCompact`, and `SubagentStop`; `PostToolUse` and `PreCompact` are absent.
2. The legacy global-state watcher is retired and no launchd job remains for `com.fitz.codex-native-agent-pool-global-state-watch`.
3. Hook source contains no SQLite write SQL and no advisor state lock.
4. A real native spawn transcript contains explicit `model` and `reasoning_effort`; native DB child rows match both.
5. A failed close or unavailable continuation leaves `thread_spawn_edges` unchanged.
6. No assistant-origin `live agent path ... not found` or lane-operation narrative survives into reusable transcript context.
7. A completed child is closed only through Codex after its result is integrated; a `SubagentStop` event causes no DB mutation or inferred close.

Run:

```bash
npm run check
npm test
node scripts/doctor.mjs
node scripts/live-check.mjs --transcript <real-parent-transcript>
```

The native runtime remains the sole lifecycle authority. A missing `PreToolUse` event is a product-boundary gap to observe with `live-check`, not a reason to invent a fallback scheduler.

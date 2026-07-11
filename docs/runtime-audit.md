# Runtime Audit

Current acceptance criteria:

1. `node scripts/doctor.mjs` reports exactly one registration for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostCompact`, and `SubagentStop`; `PostToolUse` and `PreCompact` are absent.
2. The legacy global-state watcher is retired and no launchd job remains for `com.fitz.codex-native-agent-pool-global-state-watch`.
3. Hook source contains no SQLite write SQL and no advisor state lock.
4. A real native spawn transcript contains explicit `model` and `reasoning_effort`; native DB child rows match both.
5. Each installed registered carrier has the expected model layer: `explorer` -> Luna, `worker` -> Terra, `default` -> Sol; two concurrent children may use different explicit efforts under the same carrier.
6. A failed close or unavailable continuation leaves `thread_spawn_edges` unchanged.
7. No assistant-origin `live agent path ... not found` or lane-operation narrative survives into reusable transcript context.
8. A completed child is closed only through Codex after its result is integrated; a `SubagentStop` event causes no DB mutation or inferred close.
9. Static native operations embedded in `functions.exec` obey the same carrier, effort, capacity, and exact-close checks; dynamic embedded operations are blocked.

Run:

```bash
npm run check
npm test
node scripts/doctor.mjs
node scripts/live-check.mjs --transcript <real-parent-transcript>
```

The native runtime remains the sole lifecycle authority. A missing `PreToolUse` event is a product-boundary gap to observe with `live-check`, not a reason to invent a fallback scheduler.

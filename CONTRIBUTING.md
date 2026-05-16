# Contributing

## Development

```bash
npm run check
npm test
```

Node.js 22 and `sqlite3` are required. Tests create temporary `CODEX_HOME` directories and must not touch your live Codex state.

## Change Rules

- Keep the hook advisory: it should prevent capacity collisions and route violations, not decide whether delegation is useful.
- Prefer per-parent `thread_spawn_edges` evidence over transcript inference when native state is available.
- Treat transcript evidence as fallback only.
- Add a regression test for every runtime accounting bug.
- Never add automatic broad SQLite cleanup to the hook. Use explicit scripts for operator repair.

## Release Checklist

Use `docs/release-checklist.md`.

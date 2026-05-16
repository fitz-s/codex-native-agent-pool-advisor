# Release Checklist

1. Run `npm run check`.
2. Run `npm test`.
3. Run `npm pack --dry-run`.
4. Install into a temporary `CODEX_HOME` and run `scripts/doctor.mjs`.
5. Install into live `~/.codex` only after tests pass.
6. Verify `scripts/doctor.mjs` on live state.
7. If `docs/index.html` changed, confirm the GitHub Pages workflow succeeds.
8. Commit, tag, push, and create a GitHub release with the verification commands.

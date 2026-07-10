# Release Checklist

1. Run `npm run check`.
2. Run `npm test`.
3. Run `npm pack --dry-run`.
4. Install into a temporary `CODEX_HOME` and run `scripts/doctor.mjs`:
   ```bash
   tmp=$(mktemp -d)
   CODEX_HOME="$tmp" node scripts/install.mjs
   sqlite3 "$tmp/state_5.sqlite" 'create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);'
   CODEX_HOME="$tmp" node scripts/doctor.mjs
   ```
5. Install into live `~/.codex` only after tests pass.
6. Verify `scripts/doctor.mjs` on live state.
7. For native-spawn claims, run `scripts/live-check.mjs --transcript <real_parent_transcript>` with the relevant `--expect-model` and `--expect-current-open` assertions.
8. Confirm the result reports explicit model and reasoning-effort routing, matching native child rows, and no failed legacy continuation lane.
9. If `docs/index.html` changed, confirm the GitHub Pages workflow succeeds.
10. Commit, tag, push, and create a GitHub release with the verification commands.

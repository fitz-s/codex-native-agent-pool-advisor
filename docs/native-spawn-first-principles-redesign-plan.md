# Native Spawn Redesign Record

Superseded design elements removed from the runtime path:

- global watcher and synthetic hook events;
- advisor state locks and persisted reservations;
- transcript-derived close repair and stale-edge repair;
- SQLite archive, prune, reset, and backup operations;
- role-based model prohibitions.

The live design is recorded in [First Principles](first-principles.md). The decisive rule is simple: native state is read-only evidence, never a hook-managed control plane.

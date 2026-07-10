# Delegation Control

The former design mixed admission, lifecycle repair, prompt guidance, and a global watcher. It was retired because transcript inference and SQLite mutation can disagree with Codex runtime and create cross-session failures.

The implemented design is deliberately smaller:

- read-only current-parent admission on real `PreToolUse` events;
- explicit model and effort validation without role-to-model rules;
- exact-ID close validation;
- assistant-origin transcript hygiene;
- read-only post-run verification.

No pending migration remains in this repository. Any new runtime capability must be added only after it proves an explicit parent, model, effort, and native lifecycle contract.

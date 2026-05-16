# Security Policy

## Supported Versions

Only the latest released version is supported.

## Reporting a Vulnerability

Open a private security advisory or contact the maintainer directly if a bug can corrupt Codex state, leak transcript contents, or cause unsafe SQLite mutation.

Do not post live `~/.codex/state_5.sqlite`, transcript files, or `hooks.json` with private paths in public issues. Redact thread IDs and paths unless they are necessary to reproduce the bug.

## Local State Safety

The runtime hook is designed to be advisory and fail-open on unexpected errors. It writes only its JSON state file and log during normal operation. SQLite mutation is limited to successful close-agent repair evidence; broad cleanup requires the explicit two-phase reset script.

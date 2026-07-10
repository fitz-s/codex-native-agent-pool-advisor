# Historical Design Record: Superseded

This document is retained only to explain why the package no longer trusts
implicit native-role routing. It is not a runtime contract and must not be
used to choose a model, reasoning effort, or `agent_type`.

## Superseded Assumptions

Earlier runtime probes and old `threads` rows suggested that native roles could
own a model and reasoning effort. That allowed non-fork spawns to omit `model`
and inherit historical Spark/5.4/5.5 behavior. Those observations are not
current policy and must not be replayed as a fallback.

## Current Contract

- Every non-fork lane explicitly chooses `gpt-5.6-luna`,
  `gpt-5.6-terra`, or `gpt-5.6-sol`.
- Terra is the daily default, beginning at medium effort. Luna handles bounded
  high-throughput evidence work and mechanical checks. Sol is reserved for the
  hardest independent judgment.
- `agent_type` is runtime shape only. It never supplies model or effort.
- Native `fork_context=true` is disabled because it inherits the already
  running parent model and effort. Use compact explicit context instead.
- Spark, 5.4, and 5.5 routes are retired for new non-fork lanes.

See [First-Principles Design](first-principles.md) and the README for the
normative package contract.

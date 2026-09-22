# Changelog

## 0.1.0-alpha.3 (unreleased)

- Pi preserves bounded direct-user instructions across active-session turns and supports explicit task reset.
- Added linked Pi approval, rejection, block, and release-request records. Recorded release requests do not prove execution.
- Fixed Pi 0.86 batched-edit compatibility, discovered through the new real-host read/edit/test workflow.
- Missing evidence now leaves instruction override unassessed instead of recording a misleading score. Added safe provider failure categories and evaluator/authorization fingerprints.
- Added local diagnostics, bounded audit rotation, seven-day record pruning, and expired session cleanup. Cleanup happens on access; review the pilot guide before upgrading an installation with existing logs.
- OpenCode discards pending decisions when task intent changes, the session is deleted, or the plugin is disposed.
- Fixed audit recovery for complete records missing a final newline and interrupted-compaction temporary files.
- Added a versioned synthetic evaluation corpus, separate held-out reporting, and an opt-in live result. The report includes an ambiguous instruction that Jev allowed.

Compatibility: instruction-override scores are now optional; older receipts still replay. Defaults remain observe mode with Jev disabled. No npm package is published.

## 0.1.0-alpha.2

- Added OpenCode and Pi adapters with verified user-intent handling and session isolation.
- Added Gemini CLI and Cursor hooks, with conservative blocking when native review is unavailable.
- Shared endpoint normalization, harness-attributed receipts, and protected host configuration paths.
- Added real OpenCode and Pi execution checks using a loopback fixture model, plus opt-in live Jev checks.
- Added project-scoped setup commands and a host coverage guide.

## 0.1.0-alpha.1

Initial source release.

- TypeScript decision engine with exact tool policy and argument constraints.
- Jev semantic checks with a pinned model, response validation, and bounded requests.
- Guarded execution, observe/enforce modes, and explicit review on unavailable judgment.
- Claude Code hook adapter for workspace file tools and native review of other tools.
- Local decision receipts and offline threshold replay.
- Offline tests, synthetic live smoke checks, and open-source contribution guidance.

The API is experimental. No package has been published to npm, and the project does not claim production endpoint containment.

# Threat model

Turnstile aims to catch policy violations and task drift before a cooperating agent executes a tool. The first release assumes a trusted user, trusted application integration, and a stable local workspace. It treats tool arguments, external evidence, and model responses as untrusted.

## What is enforced

- Exact tool rules and top-level argument equality constraints in the SDK.
- Workspace path boundaries, selected credential filenames, and control directories for normalized `Read`, `Write`, and `Edit` actions across supported hosts.
- Native review for Claude and interactive Pi; enforced review blocks on hosts without an approval callback.
- Review when semantic evaluation is missing, uncertain, invalid, or unavailable.
- Model risk thresholds that can tighten a permitted action.

Credential filename checks cover `.env` and `.env.*`, `.ssh`, `.aws`, `.secrets`, and `.pem`, `.key`, `.p12`, `.pfx` suffixes. Control-directory checks cover `.turnstile`, `.claude`, `.opencode`, `.pi`, `.gemini`, `.cursor`, and `.git`. `opencode.json`, `opencode.jsonc`, and `turnstile-hooks.json` are also protected. These are path policies, not content classification.

## What is outside the guarantee

**Same-user tampering.** The agent or another process with the user's permissions can alter policy, remove hooks, edit state, or invoke tools outside the integration. Turnstile is not EDR, an OS sandbox, or tamper protection.

**Filesystem races and aliases.** Path validation precedes the actual file operation. Concurrent symlink changes and hard links are not prevented. Stable path checks do not make filesystem operations atomic or identify all references to the same data.

**Shell semantics.** A command can invoke arbitrary programs and change directories. The adapters require review rather than asserting that a command string proves its effects are safe. Human approval may allow operations beyond Turnstile's file-tool checks.

**Content provenance.** Pi uses a bounded history of directly consumed user instructions; other adapters use the latest verified user prompt. No adapter reads transcripts, collects tool output, or proves which input caused an action. Without supplied evidence, instruction override remains unassessed. The SDK can receive labeled untrusted evidence, but Jev's inference remains probabilistic.

**Read contents and memory.** Each adapter checks the requested path without reading the file. Secrets in ordinary files, data already in the model's context, and sensitive information stored by another tool may be invisible.

**Host coverage.** Only registered hook events are mediated. New tools, delegate agents, background processes, skipped hooks, host failures, and host updates can change coverage. Unsupported tools request approval by default; that does not provide inspection of their internal actions.

**Semantic certainty.** The model can miss unsafe actions or flag legitimate work. Default thresholds are uncalibrated. The small synthetic smoke checks and evaluation corpus are not evidence of production detection rates. The recorded evaluation includes an ambiguous, nonempty instruction that Jev allowed despite missing earlier scope. Preserved conversation text is not a deterministic authorization or cancellation mechanism.

**Remote data handling.** Explicitly enabling Jev sends redacted context to TypeSafe. Redaction is partial. Evaluate the provider's current terms and your own data constraints before enabling it on real work.

## Deployment boundary

Use dedicated credentials, OS permissions, a sandbox, and network restrictions appropriate to the agent's task. Keep policy controlled by the operator. Treat native approvals as a grant for the exact proposed action, and inspect receipts before promoting an observe-only trial to enforcement.

No machine-wide hooks, proxy settings, certificate trust, or OS policy are changed by the CLI. This release is intended for macOS and Linux; Windows is not validated.

**Host-specific gaps.** OpenCode user shell commands and attachment reads, Pi user `!` commands and direct extension operations, and Cursor Tab completions are outside these adapters. Later plugins or extensions can mutate checked arguments and are trusted. See [integrations](harnesses.md) for each boundary.

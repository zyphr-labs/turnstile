# Architecture

Turnstile runs at a cooperating tool-execution boundary. There is no daemon, network proxy, TLS interception, kernel sensor, or hosted management service in this release.

## Decision path

1. Validate and detach the action from caller-owned data.
2. Match the exact tool name and optional argument constraints.
3. Apply any additional trusted authorization callback. Combine by taking the stricter verdict.
4. If policy permits the action, require a nonempty goal and semantic evaluation. Missing context or evaluation requires review.
5. Validate Jev's response and compare each risk probability to the thresholds.
6. Build a receipt and finish the configured audit write.
7. In enforce mode, execute only an allowed action. In observe mode, execute regardless of the policy verdict.

`check` stops at the receipt. The application is responsible for enforcement when it uses that API directly.

## Endpoint adapters

The shared runtime validates configuration, maps native tool arguments to canonical actions, and writes harness-attributed receipts. Unknown tool names keep a host prefix to avoid accidentally inheriting another integration's permissions. Adapter-specific trust and review behavior is documented in [integrations](harnesses.md).

### Claude adapter

`UserPromptSubmit` saves the latest prompt by a hash of the session ID. `PreToolUse` loads that prompt if it is less than 24 hours old, checks the action, and writes a receipt. `SessionEnd` removes the prompt file. A follow-up replaces the previous goal; the adapter does not reconstruct a multi-turn authorization history.

The endpoint authorizer handles `Read`, `Write`, and `Edit`. It compares normalized and resolved paths to the configured workspace. Existing symlinks resolve to their physical targets; new paths use the nearest existing parent. Unresolvable symlinks produce a denial through the authorization-error path. Sensitive path components and control directories are denied, including configuration directories for all supported hosts. Shell and unsupported tools require review.

An allowed or observe-only action returns `{}`. A denied action returns `permissionDecision: "deny"`. Review returns `"ask"`. The adapter never returns `"allow"`, which could bypass a host permission prompt. It does not alter arguments.

## Failure behavior

| Failure | SDK / hook behavior |
| --- | --- |
| Missing goal, disabled model or absent key | Review |
| Provider timeout, HTTP error, rate limit, malformed response | Review; provider body is not copied to logs |
| Invalid authorization callback or path resolution error | Deny |
| Invalid request or policy | SDK throws; hook exits 2 |
| Audit write fails | SDK throws; hook exits 2 |
| Internal hook deadline | Exit 2 after 12 seconds |
| Host cannot start the hook, kills it, or reaches its own timeout | Host-dependent; Claude can continue execution |

Observe mode suppresses policy enforcement, not integration errors. A malformed hook request or unavailable audit disk can still block work. If this is unacceptable for a trial, stop launching Claude with the supplied settings file until the issue is resolved.

The generated host timeout is 15 seconds. The internal deadline is intended to finish before it, but it cannot make the host's startup or timeout semantics fail closed. This release does not claim continuous or tamper-resistant endpoint enforcement.

## Receipts and replay

Each receipt has a UUID, timestamp, policy and request hashes, deterministic verdict, final verdict, reason codes, mode, enforcement flag, semantic status, scores when available, model ID, token count, and evaluation latency. The `enforced` flag records that the guard requested enforcement; it does not prove that a host blocked execution or that a person approved review. Optional harness and hashed-session fields identify adapter traffic. Latency ends before the audit write. The policy hash covers core tool policy and thresholds, not the code or configuration of an optional authorization callback.

Endpoint adapters write receipts as JSON lines with file mode `0600`. Session prompt files also use `0600`; newly created state directories use `0700`. Final file components are protected against symlink following for audit reads and writes. These measures do not prevent same-user access or replacement of parent directories.

Replay is threshold recomputation over saved probabilities, with no content or provider requests. Hard decisions remain authoritative. It is useful for inspecting approval volume, but it cannot measure accuracy without separately labeled outcomes and cannot predict the scores from a different model or prompt.

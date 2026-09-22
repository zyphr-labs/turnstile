# Policy and SDK

The SDK exports `createGuard`, `createJevJudge`, `ActionBlocked`, request and policy types, and their runtime schemas. Import from `src/index.ts` in this checkout. Package publication is deferred while the API is experimental.

## Policy

```json
{
  "version": 1,
  "mode": "observe",
  "tools": {
    "note.write": {
      "effect": "allow",
      "argumentEquals": { "path": "notes/summary.txt" }
    },
    "note.publish": { "effect": "deny" }
  },
  "unknownTool": "review",
  "thresholds": { "review": 0.35, "deny": 0.85 }
}
```

Tool names match exactly. Argument constraints compare top-level fields to scalar values without coercion. A missing or unequal field denies the action. Unknown fields in policy configuration are rejected, so a misspelled setting cannot silently weaken a rule. Unknown tools can require review or be denied; they cannot default to allow.

Both thresholds are in `[0, 1]`, with `review < deny`. The highest-risk dimension determines the semantic verdict. Review and deny thresholds are inclusive. A policy denial or review takes precedence and avoids a model request.

## Requests

Requests contain `userGoal`, `tool`, `arguments`, and optional `evidence`. Each evidence item has a `source` label and `content`; all evidence is treated as untrusted. Keep the goal and permissions in trusted application code. Do not copy a model's claimed authorization into them.

Requests are limited to 64 KB of serialized JSON. Goals and each evidence content string are limited to 16,000 characters, with at most 16 evidence items. These bounds fail with an error rather than truncating context and silently deciding on incomplete data.

## Checking and execution

`guard.check(request)` returns a decision. It does not mediate the eventual side effect. Use `guard.execute(request, executor)` when the executor can be wrapped directly. Review and denial raise `ActionBlocked` in enforce mode. In observe mode, the executor runs even if the recorded verdict is deny.

The executor receives the checked argument snapshot. Use those arguments rather than closing over a mutable original object. This prevents a caller-side mutation during an asynchronous check from changing the action being executed. It cannot prevent a filesystem or remote resource from changing after the check.

An optional `authorize(request)` callback can add deterministic restrictions. Its decision combines with tool policy by taking the stricter verdict. Errors or invalid callback verdicts deny the action. Callback reason strings are trusted application output; keep them free of private data. Supply an `authorizationIdentity` describing the callback version and effective configuration to record its separate hash. The SDK cannot automatically fingerprint callback behavior.

An optional `audit(decision)` callback persists a detached receipt before execution. Audit failure rejects the operation, including in observe mode. The SDK has no implicit global logger.

## Jev

`createJevJudge({ apiKey, timeoutMs? })` uses the fixed TypeSafe HTTPS endpoint, disables redirects, and pins `jev-1.13.0`. The default request timeout is four seconds. There are no inline retries; rate limits and outages return review so the hook has a bounded delay.

Each request asks whether the action drifts from intent or discloses data without authorization. When evidence is supplied, a third Noul question assesses task-changing instructions in that evidence. Answers must contain finite probabilities for all requested dimensions, the expected model ID, and nonnegative input-token usage. Without evidence, `scores.instructionOverride` is absent and `evidenceStatus` is `absent`; missing evidence is not a measured zero. Supplying evidence does not establish complete provenance. Invalid output cannot authorize an action.

The provider redacts common credential field names, bearer values, selected token patterns, and private-key blocks. It does not reliably identify arbitrary secrets, PII, or sensitive prose. Supply only context your deployment is permitted to send to TypeSafe.

The SDK accepts a custom `Judge` for offline tests or other providers. Such code is trusted, must implement its own timeout, and must return validated scores, a model identifier, and token usage. A custom judge must assess instruction override when evidence is supplied; otherwise the guard returns review. Without evidence, the guard removes that score even if a custom judge returns it. No other provider is shipped or advertised as tested.

## Approval ownership

The SDK does not issue reusable approval tokens or silently execute reviewed actions. Applications own their approval workflow and should bind approval to the exact action shown to the person. The Claude adapter delegates review to Claude's native permission prompt. A changed tool call must be checked again.

## Receipt compatibility

Alpha.3 keeps receipt version 1 and accepts older receipts. New optional fields include `evidenceStatus`, `semanticFailure`, evaluator version and hash, authorization hash, and adapter version. Consumers must allow `instructionOverride` to be absent. Old receipts retain their recorded scores during replay; new metadata does not retroactively establish evidence coverage.

Provider failures remain review decisions, with safe categories for authentication, rate limiting, timeout, network errors, HTTP errors, invalid responses, oversized context, and unknown failures. Provider response bodies are never copied into receipts. Missing goals and disabled Jev remain separate review reasons. There is no automatic deterministic-only fallback.

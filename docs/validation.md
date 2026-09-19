# Validation

## Offline verification

```sh
bun install --frozen-lockfile
bun run verify
```

The verification entry point checks formatting, TypeScript, offline tests, and the runnable example. CI runs it on Linux and macOS without credentials. Tests exercise the SDK executor and the shipped CLI through stdin/stdout, using temporary directories and synthetic data.

Coverage includes policy precedence, exact argument constraints, allowed execution, blocked side effects, caller mutation during a check, unavailable or malformed model output, provider response limits, timeouts, path handling, hook modes, local receipt privacy, session cleanup, and threshold replay.

These tests establish implementation behavior for their fixtures. They do not measure prompt-injection detection rates or prove endpoint containment.

## Live Jev smoke checks

Provide `TYPESAFE_API_KEY` through your secret manager or environment, then run:

```sh
bun run test:live
```

This sends synthetic content to TypeSafe and spends API usage. It checks a legitimate local note, an unrequested disclosure, and the actual Claude hook CLI with a permitted write. The synthetic executor never sends email or uploads data. The report includes scores, model version, latency, and whether the expected outcome occurred.

A review caused by provider failure is not counted as successful detection. A benign action must receive allow. Scores may vary, so this script is separate from deterministic CI. Do not tune thresholds against these few examples and call the result a benchmark.

## Real Claude Code check

Authenticate a locally installed Claude Code, provide the Jev key, and run:

```sh
bun run test:claude
```

The check generates settings for a temporary project and launches Claude with only the `Write` tool, no MCP servers, no user/project settings sources, and no session persistence. It asks Claude to write a harmless marker file. The permitted case must create the file and record a successful Jev evaluation. A deterministic denial must leave its marker absent. Each launch has a small spending limit and a 90-second process timeout. Temporary files are removed afterward.

This opt-in test consumes Claude usage as well as Jev usage. It does not install persistent hooks or change machine-wide settings. It does not validate interactive approval clicks or every Claude permission mode.

## Initial validation status

Offline verification passed locally on macOS with Bun 1.3.13. The hook protocol is covered by automated tests. Authenticated live-provider and real-host success has not yet been established for this alpha; run the opt-in checks in your environment before relying on it. No detection-rate, production-readiness, or tamper-resistance claim is made.

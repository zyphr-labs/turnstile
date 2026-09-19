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

## Real OpenCode and Pi checks

With the two hosts installed, run:

```sh
bun run test:harnesses
```

Each script starts a loopback OpenAI-compatible fixture server, loads the actual adapter into an isolated host process, and emits one harmless write tool call. Observe mode must create the expected marker. Enforced hard denial must leave it absent. The receipt must match the trusted goal and exact normalized arguments. Temporary projects, host state, and fixture servers are removed afterward.

These checks do not use an external model account. CI installs pinned OpenCode 1.18.10 and Pi 0.85.1 and runs them on Linux. Pi requires Node 22.19 or later. You can run either test independently with `bun run test:opencode` or `bun run test:pi`.

To additionally require a real Jev allow decision before the host writes a marker:

```sh
# TYPESAFE_API_KEY must already be supplied through your environment.
bun run test:live:harnesses
```

That command sends synthetic context to TypeSafe. It counts provider failure or review as a failed allowed-action test. The agent model remains the loopback fixture, so no OpenCode/Pi model login is needed.

## Initial validation status

Offline verification and real OpenCode/Pi fixture execution passed locally on macOS with Bun 1.3.13. OpenCode 1.18.10 and 1.18.31, and Pi 0.85.1, loaded the shipped adapters and enforced the tested tool decisions. Gemini and Cursor have protocol tests; their real hosts have not been run. Claude's real-host check remains blocked by host authentication.

Full live Jev enforcement has not yet completed successfully in the development environment. The opt-in scripts retain this as a failed check rather than counting unavailable-model review as detection. No detection-rate, production-readiness, or tamper-resistance claim is made.

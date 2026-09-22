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

Pi additionally runs a two-turn RPC read/edit/test workflow with exact-action confirmations, a rejected command, and a separate enforced-review case without UI. It checks completed tool results and resulting files, retained intent, and linked outcome records.

These checks do not use an external model account. CI installs pinned OpenCode 1.18.10 and tests both Pi 0.85.1 and 0.86.1 on Linux. Pi requires Node 22.19 or later. You can run either test independently with `bun run test:opencode` or `bun run test:pi`.

To additionally require a real Jev allow decision before the host writes a marker:

```sh
# TYPESAFE_API_KEY must already be supplied through your environment.
bun run test:live:harnesses
```

That command sends synthetic context to TypeSafe. It counts provider failure or review as a failed allowed-action test. The agent model remains the loopback fixture, so no OpenCode/Pi model login is needed.

## Initial validation status

Offline verification and real OpenCode/Pi fixture execution passed locally on macOS with Bun 1.3.13. OpenCode 1.18.10 and 1.18.31, and Pi 0.85.1, loaded the shipped adapters and enforced the tested tool decisions. Gemini and Cursor have protocol tests; their real hosts have not been run. Claude's real-host check remains blocked by host authentication.

Live checks passed on September 19, 2026 with Jev `jev-1.13.0`: the SDK allowed a benign note and denied an unrequested synthetic disclosure, the Claude hook CLI allowed a permitted write, and real OpenCode and Pi processes created their markers after a Jev allow decision. Both hosts also passed observe and deterministic-denial cases. These host checks used a loopback fixture for the agent model and the real TypeSafe API for Jev.

The first OpenCode live attempt timed out at the provider boundary and blocked the write with `semantic.unavailable`; a retry passed. Provider failures remain failed allowed-action tests. No detection-rate, production-readiness, or tamper-resistance claim is made.

## Alpha.3 evaluation

`bun run eval` validates the report pipeline with fixture scores. `bun run eval:live` evaluates the fixed synthetic corpus through Jev and requires an explicit API key. Calibration and held-out groups are reported separately. Provider errors are interruptions and excluded from semantic detection metrics. Ambiguous requests have their own counts.

The [recorded live report](../evals/results/2026-09-22-live.json) and [pilot guide](pilot.md#evaluation-record-and-remaining-work) include the measured outcomes and limitations. No tool action is executed by this evaluation script. Real host workflow completion is established separately by `test:pi`.

## September 22, 2026 validation

Local verification passed on macOS with Bun 1.3.13: formatting, TypeScript, 76 tests with 333 assertions, and the runnable example. The offline evaluation command and local documentation links also passed.

The real Pi RPC workflow passed on installed Pi 0.86.1 and an isolated Pi 0.85.1 invocation. Both completed read, edit, and approved tests, preserved the original restriction on the follow-up, and blocked the rejected command. Observe, hard-deny, and review-without-UI scenarios passed too.

Live Jev checks passed through the SDK, Claude hook CLI, OpenCode 1.18.10, and Pi 0.86.1. These used the saved API credential outside the repository and synthetic inputs only. The OpenCode and Pi agent models remained local fixtures. There were no provider failures in these smoke checks or the 13-call synthetic evaluation run.

This does not establish real Claude, Gemini, or Cursor host behavior, production model accuracy, daily-use completion rates, or OS containment. The RPC confirmation test uses a scripted client; a human usability trial is still needed.

## Pre-merge review

Independent reviews covered storage and recovery, Pi/endpoint integration, and evaluation claims. The follow-up fixes normalize complete audit records without a final newline, remove owned compaction remnants under the log lock, and invalidate pending OpenCode decisions when their task context changes. Regression checks cover malformed logs, unrelated files, concurrent context changes, and unchanged legitimate actions. Post-review local verification passed with 79 tests and 350 assertions, formatting, TypeScript, and the demo. Actual OpenCode and Pi fixture runs also passed.

The review leaves the roadmap priorities unchanged: a consented daily-use trial, independent ambiguous-authorization cases, actual Claude/Gemini/Cursor host runs, and confirmed execution records. No production-readiness or containment claim is added.

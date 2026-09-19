# Turnstile

[![CI](https://github.com/zyphr-labs/turnstile/actions/workflows/ci.yml/badge.svg)](https://github.com/zyphr-labs/turnstile/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Check an AI agent's next action before it executes.**

Turnstile combines deterministic permissions with [Jev](https://docs.typesafe.ai/) checks for task drift, unauthorized disclosure, and instructions from untrusted content. It returns `allow`, `review`, or `deny`, and records the decision for inspection and threshold replay.

The first integration is for Claude Code on laptops and servers. Applications can use the same TypeScript engine to guard their own tool executors.

**Status: experimental alpha.** The repository runs from source with Bun. There is no published npm package. The Claude adapter checks selected tool boundaries; it is not an endpoint sandbox or a replacement for operating-system permissions. Start in observe mode and read the [coverage and limits](docs/threat-model.md) before enabling enforcement.

## Try it

Requires [Bun 1.3.13 or later](https://bun.sh). Development and CI use 1.3.13.

```sh
git clone https://github.com/zyphr-labs/turnstile.git
cd turnstile
bun install --frozen-lockfile
bun run demo
```

The offline example permits a local note and blocks publication before the executor is called:

```text
Local note: allow; executor called.
Public upload: deny; executor not called.
```

This example uses fixed judgments so it needs no API key. It demonstrates enforcement, not model accuracy. Run `bun run verify` for formatting, type checks, tests, and the example.

## Guard an application tool

The example below runs inside this source checkout. The caller supplies trusted intent and policy; an agent must not choose its own permissions.

```ts
import { createGuard, createJevJudge } from "./src/index";

const guard = createGuard({
  policy: {
    version: 1,
    mode: "enforce",
    tools: {
      "note.write": {
        effect: "allow",
        argumentEquals: { path: "notes/summary.txt" },
      },
      "note.publish": { effect: "deny" },
    },
  },
  // Explicitly opts in to sending context to TypeSafe.
  judge: createJevJudge({ apiKey: process.env.TYPESAFE_API_KEY! }),
});

await guard.execute(
  {
    userGoal: "Save a local summary in notes/summary.txt",
    tool: "note.write",
    arguments: { path: "notes/summary.txt", content: "Meeting summary." },
  },
  async (args) => Bun.write(String(args.path), String(args.content)),
);
```

Create the `notes` directory before running that example. `execute` passes a snapshot of the checked arguments to the callback. In enforce mode it throws `ActionBlocked` for review or denial and never invokes the callback. `check` returns a decision without executing anything. The application must honor that decision.

## Use with Claude Code

Initialize configuration in a project you own:

```sh
bun run cli init --project /absolute/path/to/project
bun run cli claude-settings \
  --config /absolute/path/to/project/.turnstile/config.json \
  > /absolute/path/to/project/turnstile-hooks.json
```

Add `.turnstile/` and `turnstile-hooks.json` to that project's `.gitignore`. From the project directory, launch:

```sh
claude --settings ./turnstile-hooks.json
```

Initialization leaves existing hooks and user settings alone. Defaults are **observe mode and Jev disabled**. To evaluate actions with Jev, set `jev.enabled` to `true` in `.turnstile/config.json` and provide `TYPESAFE_API_KEY` in Claude's environment. To block or request approval, also set `policy.mode` to `"enforce"`.

Review the [installation guide](docs/claude-code.md) for data handling, approval behavior, removal, and host requirements. A policy `allow` returns no hook override, so Claude's own permissions still apply.

| Tool | First-release behavior in enforce mode |
| --- | --- |
| `Read`, `Write`, `Edit` | Check workspace and sensitive paths, then evaluate task alignment with Jev |
| `Bash` | Request native approval; no automatic shell authorization |
| Other tools, including MCP, `Glob`, `Grep`, and `WebFetch` | Request native approval by default |

## How a decision works

```text
trusted goal + proposed action + optional untrusted evidence
                         |
                 deterministic policy
                 /        |          \
              deny      review       allow
               |          |            |
               |          |      Jev judgments
               |          |            |
               +----------+------------+
                          |
                   decision receipt
                          |
              observe or enforce at executor
```

Jev never grants authority that policy denied. Explicit review rules also remain review rules. Model checks run only after deterministic permission succeeds.

| Condition | Decision |
| --- | --- |
| Explicit denial or failed argument constraint | Deny |
| Explicit review or unknown tool | Review by default |
| Any semantic score at least `0.85` | Deny |
| Any semantic score at least `0.35`, below `0.85` | Review |
| All scores below `0.35` | Allow |
| Missing goal, disabled Jev, timeout, rejected request, invalid response | Review |

The thresholds are starting values, not calibrated guarantees. Jev scores are model estimates. They do not prove that an action is authorized, safe, or influenced by an injection.

Observe mode records the same policy verdict but does not enforce it. Configuration, input, and audit failures still stop the SDK executor or produce a blocking hook error. See [failure behavior](docs/architecture.md#failure-behavior).

## Inspect and replay decisions

The Claude adapter appends JSON lines to `.turnstile/decisions.jsonl`. Receipts contain verdicts, reason codes, model scores, latency, and fingerprints, without raw prompts or tool arguments.

```sh
bun run cli replay /absolute/path/to/project/.turnstile/decisions.jsonl \
  --review 0.45 --deny 0.90
```

Replay shows which verdicts would change using the recorded scores. It makes no model calls and preserves hard denials and unavailable-model reviews. It does not re-evaluate content or simulate a new tool policy.

## Data and trust

- Jev is a hosted API. Enabling it sends the current goal, tool name, arguments, and supplied evidence to TypeSafe after limited credential redaction. File contents in `Write` and `Edit` arguments are included. Redaction is not a complete secret or PII detector.
- `Read` file contents and full Claude transcripts are not collected. The adapter cannot infer the contents of a file it has not seen. Its untrusted-evidence list is empty; application integrations can supply evidence explicitly.
- Session files store the latest raw user prompt locally with mode `0600`. Normal session end removes that file. Crashed sessions may leave files behind; there is no automatic retention cleanup.
- Audit fingerprints are unsalted hashes, not anonymization. Audit files remain local, with no telemetry or upload service.
- Same-user code can change hooks, configuration, or files. Path checks are not atomic filesystem mediation. Use OS isolation when that is part of your threat model.

## Project documentation

- [Claude Code installation and operation](docs/claude-code.md)
- [Policy and SDK reference](docs/policy.md)
- [Architecture and failure behavior](docs/architecture.md)
- [Threat model and coverage](docs/threat-model.md)
- [Validation and live checks](docs/validation.md)
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md), [agent instructions](AGENTS.md), and [security reporting](SECURITY.md)

Turnstile is a separate project from Zyphr and Lantern. It is maintained in [zyphr-labs](https://github.com/zyphr-labs), Hari's security lab. Contributions are licensed under [Apache-2.0](LICENSE).

# Pi pilot

This pilot checks a complete coding workflow through Pi: read source, edit it, approve a test command, then reject another command. It also checks that a follow-up retains earlier user restrictions. The fixture uses a local model server and temporary projects; it does not change user-wide settings.

## Run the checks

From the Turnstile checkout, with Bun and Pi installed:

```sh
bun install --frozen-lockfile
bun run verify
bun run test:pi
bun run eval
```

`test:pi` launches the real Pi host. It checks observe mode, deterministic denial, review without a UI, and a two-turn RPC workflow. The RPC test client explicitly answers each confirmation. The test inspects resulting files and Pi tool results, so a receipt alone cannot make the test pass. CI covers Pi 0.85.1 and 0.86.1, including their different edit formats.

`eval` validates the reporting pipeline with fixed scores. It does not measure Jev accuracy. With `TYPESAFE_API_KEY` supplied through your environment, the following commands send only synthetic fixtures to TypeSafe:

```sh
bun run test:live
bun run test:live:harnesses
bun run eval:live
```

## Try a project

Initialize a disposable project from the Turnstile checkout:

```sh
bun run cli init --project /absolute/path/to/project
bun run cli adapter-path --harness pi
```

Add `.turnstile/` to that project's ignore file. Start Pi from the project with `-e` followed by the printed adapter path. Configuration starts in observe mode with Jev disabled. Disabled Jev produces review decisions for otherwise permitted file actions; observe mode records them without policy blocking.

After inspecting the decisions and the [data handling](../README.md#data-and-trust), set `jev.enabled` to `true` and supply the API key in Pi's environment to assess task alignment. Set `policy.mode` to `"enforce"` to apply decisions. With Jev disabled, interactive Pi requires confirmation for permitted file actions too. Shell actions always require exact-action confirmation; Jev does not authorize shell behavior.

Give Pi a small task such as fixing a greeting typo in one file while leaving other files unchanged. Follow up with a request to run the project's tests. Inspect each confirmation before approving it. The dialog shows the actual arguments; sensitive text may be visible on screen even though outcome logs contain only metadata.

Pi retains directly consumed user instructions for the active task. The bounds are 32 instructions, 16,000 rendered characters, and 24 hours. History is held in memory. Restarts and session navigation clear it. Unmatched input, expiry, and overflow make the goal unavailable rather than silently discarding earlier restrictions. Use `/turnstile-reset`, then restate the full task and restrictions, to begin again. Use Pi's own stop control to interrupt execution; cancellation wording alone is not a deterministic stop mechanism.

## Inspect operation

```sh
bun run cli doctor --config /absolute/path/to/project/.turnstile/config.json
```

The read-only report shows configured mode, whether an API key is present in the current environment, recent adapter decisions, outcome counts, storage warnings, and locks. It makes no network request. It cannot prove that another Pi process inherited the key, that an adapter is currently loaded, or that the host enforced or executed an action. Those fields remain unknown.

`decisions.jsonl` records the guard's recommendation. Pi's `outcomes.jsonl` links operator approval or rejection and adapter block or release requests by decision ID and request hash. A `released` event is recorded before the adapter returns. If a later `blocked` event exists, it supersedes that release request. Neither event proves that the tool completed; other extensions, host failures, and tool errors may intervene.

## Storage and recovery

Each decision or outcome log retains an active file of at most 1 MiB plus three archives. Appending removes records older than seven days and rotates full files. On upgrade, oversized logs retain only complete trailing records within the new cap; older entries are discarded. Export any history you need before upgrading. A complete final record missing its newline is repaired if the normalized file stays within the cap. Malformed records and incomplete oversized tails fail without replacing the original file. After crash-lock recovery, the next append removes recognized regular compaction temporary files belonging to that log; it preserves unrelated files and symlinks. `doctor` reports migration pending for oversized logs.

Persisted prompt files belong to Claude, Gemini, and Cursor; Pi and OpenCode keep prompt state in memory. Session reads and saves remove recognized prompt files and interrupted-write temporary files older than 24 hours. No cleanup daemon runs. Inactive projects retain data until another access or deliberate deletion.

Cooperating writers use directory locks with a two-second acquisition limit. A killed writer may leave `decisions.jsonl.lock`, `outcomes.jsonl.lock`, or `sessions.lock`. First stop all agents and hooks using that project. Inspect `doctor` output, then remove only the named empty lock with `rmdir`. Do not remove locks while writers are running. Retry the original action only after deciding whether the host already performed it.

Provider failure reason codes distinguish authentication, rate limiting, timeouts, network failures, HTTP failures, invalid output, and context limits. These require review; they are not detections. Configuration errors, decision-audit failures, and oversized hook inputs can still interrupt observe mode. Enforce-mode Pi outcome-audit failures block; observe-mode outcome recording is best effort. Stop supplying `-e` to remove the project trial without editing user-wide configuration.

## Evaluation record and remaining work

The [September 22 synthetic report](../evals/results/2026-09-22-live.json) contains 16 cases: seven legitimate, seven unwanted, and two ambiguous. It records 13 successful Jev evaluations with no provider errors. All seven legitimate actions were allowed. Six unwanted actions were denied and one required review; deterministic policy alone permitted five unwanted actions. The thresholds were not changed.

The nonempty ambiguous instruction asking to continue an earlier change was allowed despite absent prior scope. The empty-goal case required review. This is a known limitation, not a successful detection. Pi's retained instruction history addresses context lost across active-session turns, but neither it nor Jev establishes authorization from vague instructions.

Held-out semantic latency was 331 ms at the median and 376 ms at the 95th percentile, from seven calls in one run. Calibration latency included a 1,008 ms call. These small sequential samples do not establish a production latency budget. The corpus uses related authored templates, not an independent benchmark or user study.

The next evidence needed is a consented daily-use trial measuring completed tasks, unnecessary confirmations, provider failures, and missed violations. Real Claude, Gemini, and Cursor host runs, approval recovery on hosts that block review, and confirmed execution receipts remain separate work. The alpha does not provide OS containment, unattended fleet operation, or a published npm package.

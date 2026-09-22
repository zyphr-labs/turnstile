# Roadmap

Alpha.3 adds a Pi pilot, multi-turn intent within an active session, linked approval outcomes, bounded local storage, diagnostics, and a synthetic evaluation record. See [pilot operation and results](docs/pilot.md). These are implementation and fixture results, not evidence of production detection rates.

## Integration priorities

Turnstile integrates with coding engines: the applications and runtimes that own tool execution, permissions, and sessions. The model used by an engine is a separate choice. Priorities follow the maintainer's installed tools and requested targets; they are not a market-share ranking.

Local inventory checked on September 22, 2026. Installed versions identify candidate test hosts, not Turnstile compatibility guarantees. See [validation evidence](docs/validation.md) for versions actually tested.

| Primary target | Local installation | Turnstile status | Next step |
| --- | --- | --- | --- |
| Claude Code | 2.1.278 | Adapter implemented; authenticated host validation pending | Validate the real host, approval handling, and session transitions. |
| Codex | 0.155.1 | No adapter | Assess pre-tool hooks and approval/completion events, then build and test a scoped adapter. |
| Pi | 0.86.1 | Adapter and pilot implemented; real-host fixture checks recorded | Run a consented daily-use trial and add reliable execution outcomes. |
| OpenCode | 1.18.10 | Plugin implemented; real-host fixture checks recorded | Extend task-intent lifecycle and outcome handling, then run a daily-use trial. |
| Kimi Code | 2.0.2 (`@moonshot-ai/kimi-code`) | No adapter | Assess this package's hook protocol, failure behavior, and approval path. |
| Prime Agent | 0.9.5 | No adapter | Assess the persistent Python tool environment and child-agent coverage independently of Pi. |
| [ZCode](https://github.com/zai-org/ZCode) | Not installed; requested target | No adapter | Assess the Agent CLI/runtime and its desktop/web entry points before choosing an integration. |

Cline 3.0.56 and Command Code 1.53.0 are also installed and belong in the next integration assessment. Cursor Agent is installed, and its existing adapter still needs real-host validation. The Gemini CLI adapter remains maintained, but Gemini CLI was not found on the local PATH and does not lead the expansion roadmap. Installation alone does not establish daily use or protection coverage.

## Next work, in order

1. **Establish useful daily operation on Pi and OpenCode.** Start with the Pi pilot. Record completed tasks, unnecessary approvals and blocks, missed violations, provider failures, and added latency. Agree on interruption and latency budgets before promoting enforcement. Expand the labeled corpus with independent tasks and ambiguous authorization; keep held-out results separate from threshold selection. The current report includes an underspecified nonempty instruction Jev allowed.
2. **Complete Claude Code validation and add Codex.** Validate Claude Code through actual sessions. For Codex, start with its documented [hooks](https://developers.openai.com/codex/hooks) and assess [app-server events](https://developers.openai.com/codex/app-server) where needed. Verify behavior against the pinned installed version. Approval requests alone are not comprehensive interception: they depend on host settings. Document tool paths that the selected integration cannot cover.
3. **Assess and add Kimi Code, Prime Agent, and ZCode.** Produce a small compatibility record for each before implementing its adapter. Use [Kimi Code's hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) for the installed package, not assumptions from a similarly named client. [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) executes actions through a persistent Python environment; shared Pi ancestry does not establish compatibility. Use the linked ZCode repository as the target and pin a version when a test host is available. If an engine cannot intercept a proposed action before effects, record that limitation rather than advertise enforcement.
4. **Carry intent and outcomes across supported engines.** Extend operator-controlled intent beyond Pi, including deliberate task changes, concurrent sessions, resume, and restart behavior. Link exact-action approval or rejection to decisions. Confirm tool completion where the host reliably exposes it, while keeping release requests distinct from execution. Design SDK approval receipts before shared queues.
5. **Evaluate the remaining installed engines.** Assess Cline and Command Code, and validate the existing Cursor adapter against the actual host. Broaden support based on use and measured coverage, while maintaining existing adapters and their documented limits.

## Evidence required for each integration

- Record engine version, launch mode, configuration, and supported tool paths. Test the actual host as well as protocol fixtures.
- Demonstrate legitimate read/edit/shell work and a policy denial before a covered action takes effect. Identify coverage of MCP, child agents, and persistent tool sessions explicitly.
- Verify review, operator rejection, cancellation, provider failure, and malformed-hook behavior. Provide an operator recovery path where review currently blocks; do not imply that a host with failure-open hooks guarantees enforcement.
- Verify trusted user intent across task changes and session lifecycle events. Keep observed evidence separate from inferred influence.
- Separate recommendations, approval outcomes, release requests, and confirmed completion in receipts. Document install, removal, limitations, interruption rate, and added latency before recommending everyday enforcement.

OS containment, enterprise fleet deployment, MCP proxying, a hosted dashboard, package publication, and provider independence require separate design decisions and evidence of need. They are not promised by this alpha.

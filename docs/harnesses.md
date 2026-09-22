# Agent integrations

All adapters use the same configuration, deterministic policy, Jev provider, and decision receipts. Built-in file tools map to `Read`, `Write`, and `Edit`; shell tools map to `Bash`. Unknown tools remain namespaced, such as `pi:custom_tool`, and require review by default.

Initialize each project from the Turnstile checkout:

```sh
bun run cli init --project /absolute/path/to/project
```

Add `.turnstile/` to that project's ignore file. Configuration starts in observe mode with Jev disabled. Set `jev.enabled: true` and provide `TYPESAFE_API_KEY` in the host process environment to enable remote evaluation. Set `policy.mode: "enforce"` after reviewing the decisions and [data handling](../README.md#data-and-trust).

| Host | Integration | Review in enforce mode | Validation |
| --- | --- | --- | --- |
| Claude Code | `UserPromptSubmit`, `PreToolUse`, `SessionEnd` | Native `ask` | Hook protocol tests; authenticated host run pending |
| OpenCode | `chat.message`, `tool.execute.before` plugin | Block | Real host writes permitted in observe mode and blocked by enforce policy |
| Pi | `input`, `message_start`, `tool_call` extension | Confirm exact action when UI is available; otherwise block | Real host writes permitted in observe mode and blocked by enforce policy |
| Gemini CLI | `BeforeAgent`, `BeforeTool`, `SessionEnd` | Block | Hook protocol tests; real host not run |
| Cursor | `beforeSubmitPrompt`, `preToolUse`, `sessionEnd` | Block | Hook protocol tests; real host not run |

The real OpenCode and Pi checks use a deterministic loopback model, so they need no model account. They test host execution and enforcement, not an external model's behavior. Live Jev approval is a separate opt-in check. Native permissions and other extensions still apply.

## OpenCode

Create a project-local plugin wrapper. The command prints code and does not install anything globally:

```sh
mkdir -p /absolute/path/to/project/.opencode/plugins
bun run cli opencode-plugin \
  > /absolute/path/to/project/.opencode/plugins/turnstile.ts
```

Start OpenCode from that project with the Jev key in its environment. The plugin loads `.turnstile/config.json` from OpenCode's project directory. `TURNSTILE_CONFIG` can select a different configuration file; its `root` must still match the project.

The wrapper contains an absolute checkout path. Regenerate it after moving Turnstile. To remove the integration, remove only this wrapper. Preserve other plugins and project settings.

Turnstile accepts nonsynthetic text from root-session user messages as intent. It verifies the session through the host SDK. Resumed sessions without a fresh prompt and model-created subagent sessions have no trusted goal and require review. The plugin keeps this state in memory, not prompt files.

OpenCode's pre-tool callback has no documented native approval method. Enforced review and denial both throw before tool execution. A model cannot turn review into permission by retrying. User-issued shell commands and prompt attachment reads can bypass the model tool callback. Reads can load instruction files, and writes can trigger host formatting or language-server work. These effects are outside direct file-operation mediation.

Checked against OpenCode 1.18.10 and 1.18.31. Sources: [plugins guide](https://opencode.ai/docs/plugins/), [plugin types](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/plugin/src/index.ts), [tool execution](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/tools.ts).

## Pi

Print the extension path from the Turnstile checkout:

```sh
bun run cli adapter-path --harness pi
```

From the project, start Pi using that absolute path:

```sh
pi -e /absolute/path/to/turnstile/src/adapters/pi.ts
```

There is no global install. Stop supplying `-e` to remove the integration. The extension reads `.turnstile/config.json` in the active project, or `TURNSTILE_CONFIG` if set.

Pi input must come from an interactive user or RPC caller and match the user message consumed by the agent. Direct instructions accumulate only when consumed, preserving earlier restrictions across follow-ups. History is limited to 32 instructions, 16,000 rendered characters, and 24 hours. Overflow, expiry, and unmatched transformed input make intent unavailable until `/turnstile-reset` and a complete task restatement. Restart and session navigation clear history. This state is memory-only; cancellation text is preserved but is not a deterministic stop command. Use Pi's stop control to interrupt an active run.

For review, the UI displays the tool, call ID, request fingerprint, reasons, and complete arguments. Approval applies to that call only. Changed arguments, consumed instructions, or session navigation invalidate it. Approval and release requests are recorded in `outcomes.jsonl`; later blocking supersedes a release request. These records do not prove execution. A hard denial never opens a confirmation. Without UI, review blocks.

The extension normalizes Pi's path syntax before checking and uses the same path for execution. Reads require the exact target to exist so the host cannot silently choose an alternate filename. User `!` commands and operations performed directly by another extension are outside `tool_call` coverage. Other extensions are trusted and may run after Turnstile.

Pi 0.85.1 single edits and Pi 0.86.1 batched edits normalize into the same engine. The real-host fixture exercises read, edit, approved tests, and a rejected action through RPC confirmation. Checked against Pi 0.85.1 and 0.86.1. Source: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Gemini CLI

Generate the settings fragment:

```sh
bun run cli gemini-settings --config /absolute/path/to/project/.turnstile/config.json
```

Merge its `hooks` arrays into the project's `.gemini/settings.json`, preserving existing entries. Do not replace an existing file with the fragment. Hook timeout values use milliseconds in this format. Remove only the Turnstile entries to uninstall.

`BeforeAgent` saves the user prompt for the session. `BeforeTool` maps `read_file`, `write_file`, `replace`, and `run_shell_command` into canonical actions. File tools must supply an absolute `file_path`; relative and `@`-prefixed paths are denied because Gemini may correct them to a different target. Unsupported tools require review. Gemini's before-tool output supports deny but no human-approval callback, so enforced review also denies the current tool call. `SessionEnd` performs best-effort prompt cleanup.

Protocol checked against the [official hook reference](https://geminicli.com/docs/hooks/reference/). A real Gemini CLI session has not been validated.

## Cursor

Generate the project hook fragment:

```sh
bun run cli cursor-settings --config /absolute/path/to/project/.turnstile/config.json
```

Merge it into `.cursor/hooks.json` in a trusted project, preserving existing hooks. Generated hooks use `failClosed: true`. Remove only these entries to uninstall. The adapter supports one workspace root; multi-root input fails closed.

The stored prompt is bound to both the conversation and generation ID. A new generation cannot inherit the old prompt. `preToolUse` requires a valid permission response, so observe/allow returns `permission: "allow"` and enforced review/deny returns `"deny"`. Cursor documents that `ask` is not enforced for this hook, so Turnstile does not emit it. Other Cursor permissions and deny hooks still apply.

The adapter handles generic agent tool calls. It does not register Tab completion hooks or claim to cover prompt attachments. File tools require the expected `file_path` argument; unknown argument shapes fail conservatively instead of guessing aliases.

Protocol checked against the [official hook reference](https://cursor.com/docs/hooks). A real Cursor session has not been validated.

## Claude Code

See the existing [Claude Code guide](claude-code.md). Its launch-scoped configuration remains compatible. `hook --harness claude` is explicit; the older `hook --config ...` form still defaults to Claude.

## Shared limits

Receipts identify the harness and a hash of its session ID. They record the guard's recommendation and requested enforcement, not proof of execution or a completed host approval. Pi records linked approval and release-request events separately. Other adapters do not yet record host approval outcomes.

Hooks and plugins run with the agent's user permissions. An agent can bypass or modify them unless separate deployment controls prevent that. Other plugins/extensions are trusted. Review [coverage and limits](threat-model.md) before treating these integrations as an endpoint security boundary.

Codex and other hosts are not advertised as supported by this release. Their interception and approval semantics need separate adapters and tests; they must not be enabled by relabeling another host's JSON.

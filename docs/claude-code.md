# Claude Code integration

The adapter consumes Claude's documented `UserPromptSubmit`, `PreToolUse`, and `SessionEnd` JSON events. The commands below scope configuration to a project and a launch. They do not install user-wide hooks.

Use Claude Code 2.1.211 or later for the documented `ask` behavior in auto mode. Installed-host validation status is recorded in [validation](validation.md). Review [upstream hook documentation](https://code.claude.com/docs/en/hooks) when upgrading; a protocol test alone does not prove every host version behaves identically.

## Set up a project

From the Turnstile checkout:

```sh
bun run cli init --project /absolute/path/to/project
bun run cli claude-settings \
  --config /absolute/path/to/project/.turnstile/config.json \
  > /absolute/path/to/project/turnstile-hooks.json
```

Add `.turnstile/` and `turnstile-hooks.json` to your project's ignore file. The generated hook commands contain absolute paths to Bun, the Turnstile checkout, and the config file. Regenerate the settings if those paths move. Initialization refuses to overwrite an existing config.

From your project:

```sh
claude --settings ./turnstile-hooks.json
```

Existing native permissions and other hooks still apply. Check Claude's `/hooks` view to confirm that the three events loaded. When integrating with an existing project settings file, merge the hook arrays; do not replace unrelated entries.

## Enable semantic checks

The generated `.turnstile/config.json` has `jev.enabled: false`. Set it to `true` only after reviewing the [data handling](../README.md#data-and-trust). Supply `TYPESAFE_API_KEY` through your secret manager or environment before launching Claude. Keep the key out of settings files and shell history.

The latest user prompt, tool name, and arguments are sent to TypeSafe after limited redaction. `Write.content` and `Edit.old_string` / `new_string` can include source code or other sensitive content. A `Read` check sends the path and arguments, not file contents. No transcript is opened.

Observe mode records would-be decisions in `.turnstile/decisions.jsonl`. Jev is required for policy-permitted file actions to receive an allow verdict; with Jev disabled, they record review.

## Enable enforcement

Change `policy.mode` to `"enforce"`. Config is loaded on each hook invocation, so changes take effect on the next event. Protect the configuration using deployment controls outside the agent when you need a stronger trust boundary than a same-user project file.

- Deny prevents the current tool call.
- Review invokes Claude's native permission prompt.
- Allow emits no permission override and leaves Claude's existing checks in charge.

The adapter does not auto-approve shell commands. In noninteractive runs, a requested approval cannot be completed by Turnstile; the host may reject the action. Keep `bypassPermissions` out of a deployment that depends on human review.

Missing or expired session state requires review. If Claude changes its working directory away from the configured root, the adapter produces a blocking integration error. Restart from the configured project rather than treating the new directory as implicitly trusted.

## Inspect and remove

```sh
bun run cli replay /absolute/path/to/project/.turnstile/decisions.jsonl
```

Receipts are metadata-only, but session files under `.turnstile/sessions` contain the latest raw prompt. Session end removes its prompt file. Files from crashed sessions remain until you remove them; timestamps older than 24 hours are ignored for decisions. Audit files have no automatic rotation yet.

To remove the launch-scoped integration, stop passing `--settings ./turnstile-hooks.json`. If you manually merged hooks elsewhere, remove only the Turnstile entries. Remove the generated settings and `.turnstile` directory after deciding whether to retain the audit. No daemon or certificate cleanup is required.

## Diagnose failures

Run `bun run cli --help` to verify the checkout still starts. Check the generated absolute paths, JSON configuration, state-directory permissions, and whether `TYPESAFE_API_KEY` reaches the Claude process. CLI diagnostics deliberately omit raw inputs and provider bodies.

Configuration and audit errors produce exit code 2 even in observe mode. The internal hook deadline also exits 2. Host startup failures and host timeouts can allow execution; see [failure behavior](architecture.md#failure-behavior).

# Working on Turnstile

Turnstile checks AI agent actions on laptops and servers. Deterministic policy defines permission; Jev adds semantic judgment. It is an application integration, not operating system containment.

- Read `CONTRIBUTING.md` before changing code. Run `bun run verify` before handing off implementation work and report any checks you could not run.
- Preserve policy precedence. Jev must never turn a deterministic denial into an approval. Keep observe and enforce behavior distinct in code, tests, and examples.
- Treat tool input, model output, and transcripts as untrusted data. Validate provider responses before using them in decisions.
- Exercise JSON hook changes through the actual stdin/stdout interface. Keep diagnostic output off protocol stdout. For OpenCode or Pi adapter changes, also run the matching `test:opencode` or `test:pi` script against the installed host.
- Use synthetic test data. Keep live Jev checks opt-in and credentials outside the repository. Do not print keys, real transcripts, or tool arguments while debugging.
- Check both unsafe and legitimate actions when changing a decision rule. Avoid tests that merely restate the implementation.
- Keep documentation claims tied to tested behavior. Describe hook coverage and bypass limits whenever changing the protection model. Read `SECURITY.md` for vulnerability reporting and deployment limits.
- Ask before changing user-wide hooks, proxy settings, certificate trust, or other machine configuration. Repository examples should be local and reversible.

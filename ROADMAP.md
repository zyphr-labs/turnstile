# Roadmap

Alpha.3 adds a Pi pilot, multi-turn intent within an active session, linked approval outcomes, bounded local storage, diagnostics, and a synthetic evaluation record. See [pilot operation and results](docs/pilot.md). These are implementation and fixture results, not evidence of production detection rates.

Next work, in order:

1. Run a consented daily-use trial on Pi. Record completed tasks, unnecessary approvals and blocks, missed violations, provider failures, and added latency. Agree on acceptable interruption and latency budgets before promoting enforcement.
2. Expand the labeled corpus with independent tasks and ambiguous authorization. Keep held-out results separate from threshold selection. The current report includes an underspecified nonempty instruction Jev allowed.
3. Validate actual Claude, Gemini, and Cursor hosts. Keep host versions pinned in test records. Design an explicit operator recovery path for integrations where review currently blocks.
4. Add outcome confirmation where the host reliably exposes it. Pi release-request records do not establish execution. Design SDK approval receipts before introducing shared queues.
5. Extend operator-controlled task intent beyond Pi, including deliberate task transitions and restart behavior. Keep observed evidence separate from inferred influence.

OS containment, enterprise fleet deployment, MCP proxying, a hosted dashboard, package publication, and provider independence require separate design decisions and evidence of need. They are not promised by this alpha.

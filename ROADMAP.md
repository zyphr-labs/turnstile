# Roadmap

The first release is a small guardrail engine and adapters for five agent hosts. Future work should follow evidence from normal use rather than a target integration count.

- Label legitimate and unwanted actions from consenting users. Measure task completion, unnecessary approvals, missed violations, and added latency before changing thresholds.
- Add operator-controlled intent and provenance across turns. Keep observed tool output distinct from inferred influence.
- Add bounded retention and audit rotation, then a local decision viewer if the CLI makes investigations cumbersome.
- Expand real-host validation for Gemini, Cursor, and Claude, and test an application integration against the same decision contract.
- Design exact-action approval receipts for SDK consumers before introducing shared approval queues.

OS containment, enterprise fleet deployment, MCP proxying, a hosted dashboard, and provider independence are separate design decisions. They are not promised by this alpha. Open an issue with the use case before starting one of those changes.

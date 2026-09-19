# Contributing to Turnstile

Turnstile is an alpha project. Reports of legitimate work being interrupted are as useful as reports of missed unsafe actions. Small fixes, reproducible examples, and documentation corrections are welcome.

For a vulnerability, use [private reporting](SECURITY.md). For a bug or proposal, [open an issue](https://github.com/zyphr-labs/turnstile/issues/new/choose). Discuss changes to policy behavior, public APIs, or new integrations before investing in a large pull request.

## Development

Install [Bun](https://bun.sh), then work from a clone of your fork:

```sh
bun install
bun run verify
```

Use the Bun version pinned by the repository when available. Keep dependency changes and the lockfile together. Verification must run without a Jev key. Live service checks are separate and require your own credentials.

For a behavior change, reproduce the problem through the affected public API or adapter. Add a test that captures the failure and a legitimate action that should still succeed. Tests must use synthetic data, temporary directories, and mocked network responses. Never commit credentials, real conversations, or endpoint logs.

## Pull requests

Keep each pull request focused on one problem. Describe the old behavior, the new behavior, and the commands you ran. Explain changes to defaults, data sent to Jev, and enforcement decisions. Update examples and documentation when the user-visible behavior changes.

Policy denials must remain authoritative. Semantic judgment cannot grant permission that deterministic policy denied. Observe mode must remain explicit in examples that discuss protection, because it does not block actions.

Maintainers review changes through GitHub pull requests. Passing checks does not guarantee acceptance, especially for changes that expand the product's scope or maintenance burden.

## License and conduct

Contributions are accepted under the project's [Apache-2.0 license](LICENSE). Submit only material you have the right to contribute under those terms. No separate contributor license agreement is required.

The [code of conduct](CODE_OF_CONDUCT.md) applies to project participation.

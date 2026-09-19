# Security policy

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/zyphr-labs/turnstile/security/advisories/new). Do not put exploitable details, credentials, or private endpoint data in a public issue.

Include the commit or version tested, operating system and runtime, integration, relevant policy with secrets removed, expected decision, actual decision, and a minimal reproduction using synthetic data. Explain the trust boundary you believe the issue crosses.

The project has no guaranteed response time or bug bounty. Maintainers will coordinate disclosure through the private report where possible. Test only systems and data you are authorized to use.

## Supported code

Turnstile is alpha software. Security fixes target the current default branch. There are no supported long-term maintenance branches. Pin a reviewed commit for deployments and check the repository for updates.

## Protection limits

Turnstile evaluates actions submitted through its SDK or configured adapter. It is not an operating system sandbox. An agent with the same user's permissions may modify hooks, policy files, or the code that calls Turnstile. Actions outside an integration's coverage are not checked.

Observe mode records decisions without blocking. Enforcement depends on the host honoring the adapter's result. Semantic judgment can miss unsafe actions and flag legitimate work. A policy denial must never become an approval because Jev judged an action safe.

Treat policy files, integration configuration, and audit records as sensitive. Review what context an integration sends to Jev before enabling it. Redaction reduces accidental exposure but cannot guarantee that arbitrary text contains no secrets.

Reports about behavior that exceeds these documented limits can still help improve the documentation. A bypass of an advertised enforcement rule, unintended data disclosure, or a failure that silently weakens configured enforcement belongs in a private security report.

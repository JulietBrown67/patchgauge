# Security Policy

## Supported version

Security fixes target the latest public release and the default branch.
`v0.2.0-experimental.3` is an opt-in experiment. It makes no compatibility
claim for arbitrary repositories and has no fixed remediation-time
commitment. Run it only on trusted repositories with recoverable work.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting on this repository when available.
Do not put exploit details, secrets, private paths, private source, or
sensitive logs in a public issue. If private reporting is unavailable, ask
for a private contact channel in a minimal public issue without details.

Include the affected public version, a reproduction using public files,
impact, and any mitigation. Maintainers may withdraw a Release or disable an
affected capability before a fix is available.

## Local execution boundary

The service runs repository tests, so authorize only repositories and test
paths you trust. It binds to `127.0.0.1` and requires a startup token. It is
not a sandbox for untrusted test code. See
[the security boundary](docs/security-boundary.md).

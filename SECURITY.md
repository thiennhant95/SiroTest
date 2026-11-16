# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| < 0.2 | No |

## Reporting a vulnerability

Please **do not** open a public issue. Report privately:

- GitHub → **Security** tab → **Report a vulnerability** (preferred), or
- email the maintainer listed on the GitHub profile.

Include: affected version, reproduction steps, impact, and any proof of concept.

We aim to acknowledge within 3 working days and to ship a fix or mitigation
within 30 days for confirmed issues.

## Deployment hardening (self-hosters)

SiroTest is designed to run inside a company network. Before exposing it:

1. Set `ALLOW_DEV_AUTH=0` on any host reachable from the network.
2. Do not publish ports 3001/5173 to the internet — use Tailscale, a VPN or an
   identity-aware proxy.
3. Keep `SECRET_ENCRYPTION_KEY` private; rotate it only with a migration plan
   (existing secrets are encrypted with it).
4. Leave `ALLOW_PRIVATE_TARGETS` unset unless you are testing against local
   fixtures.
5. Rotate integration/LLM API keys if they leak.

## Scope

In scope: SSRF guards, secret handling/redaction, auth and RBAC, path traversal in
artifacts, prompt-injection paths in AI features.
Out of scope: issues that require an already-compromised host, or third-party
services you configured yourself.

# SiroTest Pro — product plan

> Status: planning. The core stays MIT and keeps working forever without a
> license. Pro adds the things companies buy when a team grows: governance,
> scale and support. Nothing in this document is a promise of a date.

## Positioning

| Layer | What it is | License |
|---|---|---|
| **Core** | Record, author, run, suites, schedules, audit (read), export, AI with your key | MIT — free forever |
| **Pro** | Governance, scale, reporting, support | Commercial |
| **Enterprise** | SSO/SAML, air-gapped install, custom terms | Commercial + contract |

Rule we do not break: **never paywall what a tester already uses daily.**
Recording, running, Gherkin, export, audit visibility and self-hosting stay free.

## What Pro adds

### 1. Access & governance
- SSO (OIDC) + SCIM-style user provisioning
- Role templates and per-project policies
- Org-level audit export (CSV/JSON) with retention controls
- Member invite by email with expiry (core has manual add only)

### 2. Scale
- Distributed runners (multiple hosts, shared queue)
- Parallel suite execution beyond 2 (configurable pools)
- Priority queues (interactive runs jump ahead of scheduled runs)
- Artifact storage backends (S3-compatible) + retention policy per project

### 3. Insight
- Flaky trend history beyond the recent window (per test, per suite)
- Release readiness report (gate status per suite, diffs between runs)
- Compliance pack: signed run evidence (who ran what, artifact hashes)
- SLA dashboard (schedule success, mean time to detect)

### 4. Support
- Named contact, response SLA (next business day / 4h)
- Upgrade assistance and migration reviews
- Private issue tracker channel

## Packaging

| | Free | Team | Enterprise |
|---|---|---|---|
| Price | 0 | per host / year | contract |
| Projects | unlimited | unlimited | unlimited |
| Members | unlimited | unlimited | unlimited |
| Parallel runs | 2 | pools | pools |
| SSO | — | optional | included |
| Audit export | — | included | included |
| Runners | 1 host | up to 3 | unlimited |
| Support | community | business hours | SLA |

Why per host, not per seat: testers should never be the reason a company hesitates.
The cost driver is execution infrastructure and governance, not humans.

## Sequencing (why this order)

1. **Member invite UI** — shipped in core; removes the last script dependency.
2. **Audit export** — smallest Pro feature, highest compliance value.
3. **SSO** — unlocks enterprise deals; blocks on real IdP testing.
4. **Distributed runners** — needed above ~3 projects running nightly.
5. **Release readiness report** — the artifact managers forward to clients.
6. **SLA dashboard** — only meaningful once schedules are used daily.

## Success metrics

- Activation: a new install records and runs a test in < 15 minutes.
- Retention: a project still runs weekly after 30 days.
- Conversion: pilot → paid support/Team within 60 days of a successful pilot.
- Support load: < 2 tickets per active install per month (otherwise Pro is not ready).

## Legal and licensing

- Core: MIT (see `LICENSE`). Already-published versions stay MIT forever.
- Pro: separate commercial license, separate repository or `pro/` subtree.
- Trademark: the SiroTest name and logo are not granted by MIT.
- Air-gapped/enterprise installs: same artifacts, offline license file.

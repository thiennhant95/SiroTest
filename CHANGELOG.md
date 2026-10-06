# Changelog

Format follows Keep a Changelog. Dates are commit dates (`git log --oneline`).

## [Unreleased] — 2026-10-03..2026-10-06

### Added
- Vietnamese Gherkin tab: deterministic `Cho rằng/Khi/Thì` parser + `POST /ai/gherkin` + Builder tab (`3bb800c`)
- Generic HMAC webhook provider (`url` + `signingSecret`) with run-terminal fan-out (`run.passed/failed/cancelled`) (`e129a32`)
- Schedule failure alerting: per-schedule `notifyOnFailure` + `lastStatus` badge (`1915cc9`)
- Schedule Run-now endpoint (`c07e594`)
- Bug-from-failure integrations (Jira/Backlog/Slack/Lark + Markdown) with iframe frame scope (`9441214`)
- P2 healing that probes in-spec alternatives + headroom (`0da9be9`)
- AI compose/discovery: unquoted VI fill, VI fill pattern (`8db6728`, `c95e09c`)
- `axeCheck` step: axe-core WCAG scans with critical/serious gate (`9df17a9`)
- Responsive viewports + `mockRoute` step for API-failure UI states (`2e97cc9`)
- VariableInput picker + preview, Builder tour (`2384f35`)
- In-app Docs page (sidebar layout, tables/code/callouts) (`2f3bb0b`)
- CI pro workflow: split jobs, least-privilege, SHA pins, artifacts (`a56cf6c`)

### Changed
- Write-tagged tests warn (never block) in suite runs (`b42ec58`)
- Restyled inner sub-pages (Actions/Profiles/Files/Suites/Schedules/Audit/AI/Visual/Analytics/Workers/Plugins) (`42898d4`)
- Rebrand UI to SiroTest; English UI + uniform buttons + dual-stack Vite (`faa98c1`, `d891781`)

### Fixed
- All UI deletes: bodiless POST/DELETE send `'{}'` centrally (`b4af6b9`)
- Step `timeoutMs` forwarded into `expect()` polling in both compilers (`6e512b7`)
- Fail fast on id-less definitions + backfill `definition id/projectId` (`61fee11`)
- Reject duplicate variables (SQLite NULL gotcha) (`c95e09c`)
- Run-test id guard + plugins path hygiene (`1915cc9`)
- UX audit fixes: record guide steps, run page test-name fallback (`da751ca`)
- Pilot-driven fixes: observe/debug run modes, evidence pipeline, shell restyle (`f7d0804`)

### Security
- RBAC: project viewer read-only + membership gates on all routes + delete guards (`54b8647`)
- Audit coverage: run-now, healing approve/reject, deletes, schedule notify (`c07e594`)
- Encrypted integration secrets, never returned by read APIs (`9441214`)

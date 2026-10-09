# Changelog

Format follows Keep a Changelog. Dates are commit dates (`git log --oneline`).

## [Unreleased] — 2026-10-03..2026-10-06

### Added
- Compiler parity gate extended to P1/P2/plugin steps (both compilers, same order, transpile-clean) (`3a5ba98`)
- Vietnamese Gherkin tab: deterministic `Cho rằng/Khi/Thì` parser + `POST /ai/gherkin` + Builder tab (`3bb800c`)
- Generic HMAC webhook provider (`url` + `signingSecret`) with run-terminal fan-out (`run.passed/failed/cancelled`) (`e129a32`)
- Schedule failure alerting: per-schedule `notifyOnFailure` + `lastStatus` badge (`1915cc9`)
- Schedule Run-now endpoint (`c07e594`)
- Bug-from-failure integrations (Jira/Backlog/Slack/Lark + Markdown) with iframe frame scope (`9441214`)
- P2 healing: on primary failure the run probes stored alternative locators and files a verified, reviewable proposal (`0da9be9`)
- AI compose: understands unquoted Vietnamese fill (`điền email a@x.io`, `nhập X là Y`) (`8db6728`, `c95e09c`)
- `axeCheck` step: axe-core WCAG scans with critical/serious gate (`9df17a9`)
- Responsive viewports + `mockRoute` step for API-failure UI states (`2e97cc9`)
- VariableInput picker + preview, Builder tour (`2384f35`)
- In-app Docs page (sidebar layout, tables/code/callouts) (`2f3bb0b`)
- CI pro workflow: split jobs, least-privilege, SHA pins, artifacts (`a56cf6c`)

### Changed
- Write-tagged tests warn (never block) in suite runs (`b42ec58`)
- Restyled inner sub-pages (Actions/Profiles/Files/Suites/Schedules/Audit/AI/Visual/Analytics/Workers/Plugins) (`42898d4`)
- Rebrand UI to SiroTest; English UI + uniform buttons + IPv4/IPv6 dual-stack dev server (`faa98c1`, `d891781`)

### Fixed
- PATCH create/update schemas reject unknown keys instead of silently dropping them (`6f15ffa`)
- Empty `:projectId` fails 400 instead of FK 500 (`6f15ffa`)
- Quoted Vietnamese goto (`Mở "https://…"`) parses in NL/Gherkin (`6f15ffa`)
- Healing + AI explain treat vanished-element `expect()` errors as locator failures (text-mismatch still excluded) (`6f15ffa`, `4ac7474`)
- Recorder stop omits null targets from stored steps (`4ac7474`)
- All UI deletes: empty POST/DELETE requests send `'{}'` body centrally (server rejects bodiless JSON) (`b4af6b9`)
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
- Plugin file paths no longer exposed to browser clients (`1915cc9`)

### Docs
- API spec, security spec, in-app Docs, operator webhook note, this changelog (`60dd0db`)
- Scope/vision/personas/roadmap/user-flows reflect shipped state (`2fe7077`)

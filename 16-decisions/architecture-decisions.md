# Architecture Decisions

## ADR-001 — Do not fork Playwright core
**Decision:** upstream `@playwright/test` remains engine. **Reason:** compatibility, upgrades, ecosystem and maintenance cost.

## ADR-002 — JSON definition is canonical
**Decision:** visual editor and compiler operate on versioned JSON. Generated TypeScript is output. **Reason:** round-trip editing of arbitrary TypeScript is not reliably solvable for an MVP.

## ADR-003 — Keep alternative locators
**Decision:** recorder stores ranked candidates. P0 executes primary only. **Reason:** enables future repair without changing P0 semantics.

## ADR-004 — SQLite first
**Decision:** SQLite P0 with PostgreSQL-compatible Prisma model. **Reason:** fastest self-host/development path; migrate when concurrency requires it.

## ADR-005 — No AI in P0
**Decision:** deterministic recorder/compiler first. **Reason:** prove UX and execution before adding nondeterministic behavior.

## ADR-006 — Custom code is an escape hatch, not normal tester UX
**Decision:** Developer/Admin only and sandbox carefully. **Reason:** preserves no-code safety and security boundary.

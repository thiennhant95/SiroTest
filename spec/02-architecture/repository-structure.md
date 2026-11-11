# Repository Structure

```text
playwright-studio/
├─ apps/
│  ├─ web/                 # React/Vite UI
│  ├─ server/              # Fastify REST/WS API
│  └─ runner/              # isolated execution entrypoint
├─ packages/
│  ├─ test-model/          # schemas/types/migrations
│  ├─ playwright-compiler/ # JSON -> TypeScript
│  ├─ locator-engine/      # candidates/scoring/conversion
│  ├─ recorder/            # event capture + normalization
│  ├─ reporter/            # custom Playwright reporter/events
│  ├─ action-sdk/          # P1 reusable/custom action contract
│  └─ shared/
├─ prisma/
├─ storage/
│  ├─ runs/
│  └─ exports/
├─ docs/
└─ examples/
```

Use pnpm workspaces + Turborepo. Keep packages independently testable.

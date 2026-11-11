# Test Strategy

## Unit
- Test-model schema validation/migrations
- Locator candidate scoring
- Locator → Playwright expression conversion
- Each compiler step type
- Variable interpolation/redaction
- Recorder normalization/debounce

## Golden compiler tests
Maintain JSON fixtures with expected `.spec.ts` snapshots. Generated code must also parse/typecheck.

## Integration
- API CRUD/versioning
- Run lifecycle with tiny fixture web app
- Recorder capture → definition
- Artifact persistence
- WebSocket event ordering/state recovery

## E2E
Use Playwright to test Studio itself: create project → record fixture app → add assertion → run → inspect PASS; then intentional failure → screenshot/trace available.

## Release gate P0
No known data-loss bug; compiler coverage for every P0 step; core E2E green on Chromium; secret redaction tests green; interrupted runner/recorder recovery tested.

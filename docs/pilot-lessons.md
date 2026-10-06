# Pilot lessons (staging-driven test authoring)

Distilled from the LienHoa / DeltaPOS / A2SIGN pilots. Applies to every future pilot.

## 1. Let Studio runs discover; don't over-probe
Write the test from minimal verified facts, then iterate on run evidence
(exact error text, failure screenshot, trace/video). Hand probes are slower
and flakier than the `seed → run → read evidence → patch` loop.

## 2. Async UI needs explicit waits + per-step timeouts
Dropdowns, Stripe iframes, toasts and hydration routinely exceed the 5s
`expect` default on slow staging. Add a settle `waitForTimeout` after fills
that trigger async lists, and set step `timeoutMs` (it now extends `expect()`
polling in both compilers).

## 3. Tag side effects on day one
Any test that creates real data gets the `writes` tag immediately — before it
can spam staging (orders, addresses, subscriptions). Suite/schedule dialogs
warn on tagged members; the tester still decides.

## 4. Screenshot after every important stage
Cheap, and the screenshot — not the log — is what reveals confirm modals,
infinite skeletons, and backend 500 banners. Keep `screenshot` steps at stage
boundaries; they are the primary debugging artifact alongside trace.

## 5. Strict-mode violations are locator feedback, not noise
- Placeholder substrings match broadly (`Tên` also matches `Tên công ty`) → prefer CSS by `name`.
- Duplicated texts (nav + heading) → role over text, or exact + scoping.
- Repeated widgets (product tiles, multiselects) → scope XPath to the visible container, never a global index.

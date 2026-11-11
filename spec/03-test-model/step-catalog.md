# P0 Step Catalog

## Navigation
- `goto { url }`
- `reload`
- `goBack`
- `goForward`

## Interaction
- `click { target }`
- `doubleClick { target }`
- `fill { target, value, sensitive? }`
- `clear { target }`
- `press { target?, key }`
- `check { target }`
- `uncheck { target }`
- `select { target, value }`
- `hover { target }`

## Wait
- `waitForElement { target, state }`
- `waitForTimeout { milliseconds }` — visible warning because fixed waits are discouraged
- `waitForURL { url|pattern }`

## Assertions
- `assertVisible { target }`
- `assertHidden { target }`
- `assertText { target, expected }`
- `assertContainsText { target, expected }`
- `assertValue { target, expected }`
- `assertURL { expected|pattern }`
- `assertTitle { expected }`
- `assertEnabled { target }`
- `assertDisabled { target }`
- `assertChecked { target }`

## Utility
- `screenshot { name?, fullPage? }`

## P1 candidates
API request/assertion, file upload/download, tabs/windows, dialogs, iframe helper, storage state, reusable action, loops/conditions only if a concrete QA need justifies them.

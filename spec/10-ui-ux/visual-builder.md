# Visual Builder

## Step list capabilities
Add, edit, reorder via drag/drop, duplicate, disable/enable, delete, rename and insert before/after.

## Add Step palette
Navigation / Interaction / Wait / Assertion / Utility. Search by human terms such as “click”, “text”, “URL”.

## Inspector
Fields change by step type. Locator-bearing steps expose readable target summary first, with Advanced section for exact locator strategy.

## Locator UX
Display `Button “Login”` rather than raw JSON. Advanced preview may show `getByRole('button', { name: 'Login' })`.

## Fixed waits
`waitForTimeout` is available but marked “Use only when necessary”; suggest state/element waits instead.

## Unsaved changes
Autosave draft with clear Saving/Saved/Error state. Run always uses a known persisted revision.

# Playwright Compiler

Compiler transforms validated `TestDefinition` into deterministic TypeScript using upstream `@playwright/test`.

## Requirements
- Pure/deterministic for same definition + compiler version.
- Escape all generated strings safely.
- Never inline secret values.
- Preserve step names using `test.step()` when useful for reporting.
- Generated export should be readable, not minified.
- Unsupported step fails compilation with explicit error; never silently skip.

## Locator mapping
`role` → `page.getByRole()`; `label` → `getByLabel()`; `placeholder` → `getByPlaceholder()`; `testId` → `getByTestId()`; `text` → `getByText()`; `css/xpath` → `page.locator()`.

## Example
Input:
```json
{"type":"click","target":{"primary":{"strategy":"role","role":"button","name":"Login"}}}
```
Output:
```ts
await page.getByRole('button', { name: 'Login' }).click();
```

## Variables
Compile `{{NAME}}` references to an injected runtime env/config helper. Secret values are resolved at run time and redacted from logs.

## Export modes
P0: single test `.spec.ts`; optional ZIP with minimal `package.json`/config. P1: project/suite export and reusable helper files.

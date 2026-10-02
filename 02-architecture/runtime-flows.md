# Runtime Flows

## Compile/run
`definition JSON → validate → resolve environment refs → compile temporary Playwright project/spec → execute → reporter emits events → persist run/step status → store artifacts`

## Record
`create recorder session → launch headed browser → inject/capture events → DOM/ARIA analysis → candidate locators → normalize/debounce → WebSocket → append draft steps → stop → persist definition`

## Locator test
`UI locator editor → API session → resolve locator in current recorder browser → return match count + preview metadata → highlight matches`

## Failure rule
Execution errors must preserve the original Playwright message/stack internally. UI may show a simplified message but must provide raw details to Developer role.

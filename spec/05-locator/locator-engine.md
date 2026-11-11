# Locator Engine

## Priority
1. Role + accessible name
2. Label
3. Placeholder
4. Test ID
5. Stable text
6. Stable CSS
7. XPath fallback

Priority is not absolute: candidates must also be unique and stable.

## Candidate scoring
Suggested factors:
- unique match: +high
- semantic/accessible locator: +high
- explicit test id: +high
- stable short text: +medium
- dynamic-looking ids/classes: penalty
- nth-child/nth-of-type: strong penalty
- long DOM chain: strong penalty
- XPath: fallback penalty

## Output
Return primary + alternatives + match count + human-readable preview.

## Test Locator
Given active browser session and candidate, return `0/1/N` matches and highlight matched element(s). A step cannot be saved as healthy when locator matches 0; multiple matches show warning unless action/assertion permits multiple.

## P2 self-healing preparation
Alternatives are evidence only in P0. Never silently switch locator during execution. P2 healing must be explicit/auditable.

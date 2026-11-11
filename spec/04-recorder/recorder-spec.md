# Recorder Specification

## Goals
Capture normal tester interaction and convert it into clean semantic Playwright steps.

## Events captured
Navigation, click/double-click, input/change, select, checkbox/radio, meaningful key press and optional hover. Do not record every mousemove/focus event.

## Normalization
- Collapse continuous typing on same input into one `fill`.
- Replace previous `fill` value while user is still editing inside debounce window.
- Suppress click on input when immediately followed by a fill unless click has semantic importance.
- Collapse duplicate navigations caused by redirects when appropriate; preserve final navigation evidence.
- Mask password/sensitive fields at capture time.

## Session
Each recorder session owns a browser/context/page set and expires on disconnect/timeout. P0 supports one active recorder session per user/test.

## Browser bridge
Injected recorder script sends minimal event metadata. Server-side locator engine may evaluate DOM/ARIA through Playwright to produce candidates. Avoid trusting raw selector strings supplied by page JS.

## Controls
Start, Pause, Resume, Stop, Pick Locator, Add Assertion.

## Recovery
If browser closes unexpectedly, keep already captured draft steps and mark session interrupted.

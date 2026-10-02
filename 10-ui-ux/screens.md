# UI Screens

## Required P0 routes
- `/login`
- `/projects`
- `/projects/:id`
- `/projects/:id/tests`
- `/tests/:id` — primary builder
- `/tests/:id/record`
- `/runs/:id`
- `/settings`

## Test builder layout
```text
┌──────────────────────────────────────────────────────────┐
│ Test name                    Environment ▼  Record  Run  │
├──────────────┬─────────────────────────────┬─────────────┤
│ Test tree    │ Steps                       │ Inspector   │
│ / search     │ 1 Navigate /login           │ Action      │
│              │ 2 Fill Email                │ Locator     │
│              │ 3 Fill Password             │ Value       │
│              │ 4 Click Login               │ Timeout     │
│              │ 5 Assert Dashboard          │ Test locator│
│              │ + Add step                  │             │
├──────────────┴─────────────────────────────┴─────────────┤
│ Steps | Variables | Runs | Code | History                │
└──────────────────────────────────────────────────────────┘
```

## Run page
Header status + environment/browser/duration; timeline of steps; failed step expanded by default; screenshot; error; Open Trace.

## UX rule
Manual tester should never need to understand `page.locator()` to complete a normal P0 flow. Advanced locator/code is progressively disclosed.

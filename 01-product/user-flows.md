# Primary User Flows

## A. Record a test
1. Tester creates test and selects environment.
2. Clicks **Record**.
3. Studio launches a headed Playwright browser/context.
4. Tester navigates and interacts normally.
5. Recorder converts browser events into semantic steps and locator candidates.
6. Tester stops recording; steps are saved as a draft.
7. Tester cleans names, removes noise and adds assertions.
8. Tester runs test and saves after pass.

## B. Add assertion
1. Choose **Add assertion** / picker mode.
2. Select an element in browser.
3. Studio proposes Visible, Hidden, Text equals/contains, Value, Enabled/Disabled, Checked.
4. Tester enters expected value if required.
5. Step is inserted at selected position.

## C. Debug failure
1. Run fails on a step.
2. UI focuses failed step.
3. Show concise error + locator + elapsed timeout + screenshot.
4. Provide **Open Trace** and **Edit locator**.
5. Tester changes locator/assertion and reruns from whole test in P0.

## D. Developer escape hatch
Developer opens Code tab, copies/exports generated `.spec.ts`, or creates a developer-only custom action when visual primitives are insufficient.

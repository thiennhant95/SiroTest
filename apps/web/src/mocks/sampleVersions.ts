import type { TestVersion } from "../types";

const now = Date.now();

export const sampleVersions: TestVersion[] = [
  {
    id: "v3",
    testId: "test_demo_login",
    versionNumber: 3,
    createdBy: "linh.tester",
    changeMessage: "Edit step 4: rename Login button",
    createdAt: new Date(now - 3600_000).toISOString(),
    definitionJson: {
      schemaVersion: "1.0",
      name: "Staging login",
      steps: [
        { id: "s1", type: "goto", name: "Open /login page" },
        { id: "s2", type: "fill", name: "Enter email" },
        { id: "s3", type: "fill", name: "Enter password" },
        { id: "s4", type: "click", name: "Click Login (new)" },
        { id: "s5", type: "assertVisible", name: "See Dashboard" },
      ],
    },
  },
  {
    id: "v2",
    testId: "test_demo_login",
    versionNumber: 2,
    createdBy: "linh.tester",
    changeMessage: "Add Dashboard check step",
    createdAt: new Date(now - 86400_000).toISOString(),
    definitionJson: {
      schemaVersion: "1.0",
      name: "Staging login",
      steps: [
        { id: "s1", type: "goto", name: "Open /login page" },
        { id: "s2", type: "fill", name: "Enter email" },
        { id: "s3", type: "fill", name: "Enter password" },
        { id: "s4", type: "click", name: "Click Login" },
        { id: "s5", type: "assertVisible", name: "See Dashboard" },
      ],
    },
  },
  {
    id: "v1",
    testId: "test_demo_login",
    versionNumber: 1,
    createdBy: "linh.tester",
    changeMessage: "First version from recording",
    createdAt: new Date(now - 2 * 86400_000).toISOString(),
    definitionJson: {
      schemaVersion: "1.0",
      name: "Staging login",
      steps: [
        { id: "s1", type: "goto", name: "Open /login page" },
        { id: "s2", type: "fill", name: "Enter email" },
        { id: "s4", type: "click", name: "Click Login" },
      ],
    },
  },
];

export const sampleSpecCode = `// Auto-generated code — runs with stock @playwright/test, no Studio needed.
import { test, expect } from '@playwright/test';

test('Staging login', async ({ page }) => {
  await test.step('Open /login page', async () => {
    await page.goto(process.env.BASE_URL ?? '/login');
  });

  await test.step('Enter email', async () => {
    await page.getByLabel('Email').fill(process.env['USER_EMAIL'] ?? '');
  });

  await test.step('Enter password', async () => {
    await page.getByLabel('Password').fill(process.env['USER_PASSWORD'] ?? '');
  });

  await test.step('Click Login', async () => {
    await page.getByRole('button', { name: 'Login' }).click();
  });

  await test.step('Verify Dashboard loaded', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
`;

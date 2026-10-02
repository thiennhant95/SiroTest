import { test, expect } from '@playwright/test';

test('Login successfully', async ({ page }) => {
  await test.step('Navigate to login', async () => {
    await page.goto(`${process.env.BASE_URL}/login`);
  });

  await test.step('Fill Email', async () => {
    await page.getByLabel('Email').fill(process.env.ADMIN_EMAIL!);
  });

  await test.step('Fill Password', async () => {
    await page.getByLabel('Password').fill(process.env.ADMIN_PASSWORD!);
  });

  await test.step('Click Login', async () => {
    await page.getByRole('button', { name: 'Login' }).click();
  });

  await test.step('Verify Dashboard', async () => {
    await expect(page.getByText('Dashboard')).toBeVisible();
  });
});

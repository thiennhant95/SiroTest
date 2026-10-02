import type { TestVersion } from "../types";

const now = Date.now();

export const sampleVersions: TestVersion[] = [
  {
    id: "v3",
    testId: "test_demo_login",
    versionNumber: 3,
    createdBy: "linh.tester",
    changeMessage: "Sửa bước 4: đổi tên nút Đăng nhập",
    createdAt: new Date(now - 3600_000).toISOString(),
    definitionJson: {
      schemaVersion: "1.0",
      name: "Đăng nhập staging",
      steps: [
        { id: "s1", type: "goto", name: "Mở trang /login" },
        { id: "s2", type: "fill", name: "Nhập Email" },
        { id: "s3", type: "fill", name: "Nhập Mật khẩu" },
        { id: "s4", type: "click", name: "Nhấn nút Đăng nhập (mới)" },
        { id: "s5", type: "assertVisible", name: "Thấy Dashboard" },
      ],
    },
  },
  {
    id: "v2",
    testId: "test_demo_login",
    versionNumber: 2,
    createdBy: "linh.tester",
    changeMessage: "Thêm bước kiểm tra Dashboard",
    createdAt: new Date(now - 86400_000).toISOString(),
    definitionJson: {
      schemaVersion: "1.0",
      name: "Đăng nhập staging",
      steps: [
        { id: "s1", type: "goto", name: "Mở trang /login" },
        { id: "s2", type: "fill", name: "Nhập Email" },
        { id: "s3", type: "fill", name: "Nhập Mật khẩu" },
        { id: "s4", type: "click", name: "Nhấn nút Đăng nhập" },
        { id: "s5", type: "assertVisible", name: "Thấy Dashboard" },
      ],
    },
  },
  {
    id: "v1",
    testId: "test_demo_login",
    versionNumber: 1,
    createdBy: "linh.tester",
    changeMessage: "Bản đầu tiên từ ghi thao tác",
    createdAt: new Date(now - 2 * 86400_000).toISOString(),
    definitionJson: {
      schemaVersion: "1.0",
      name: "Đăng nhập staging",
      steps: [
        { id: "s1", type: "goto", name: "Mở trang /login" },
        { id: "s2", type: "fill", name: "Nhập Email" },
        { id: "s4", type: "click", name: "Nhấn nút Đăng nhập" },
      ],
    },
  },
];

export const sampleSpecCode = `// Mã tự động sinh — chạy được bằng @playwright/test gốc, không cần Studio.
import { test, expect } from '@playwright/test';

test('Đăng nhập trang staging', async ({ page }) => {
  await test.step('Mở trang /login', async () => {
    await page.goto(process.env.BASE_URL ?? '/login');
  });

  await test.step('Nhập Email', async () => {
    await page.getByLabel('Email').fill(process.env['USER_EMAIL'] ?? '');
  });

  await test.step('Nhập Mật khẩu', async () => {
    await page.getByLabel('Mật khẩu').fill(process.env['USER_PASSWORD'] ?? '');
  });

  await test.step('Nhấn nút Đăng nhập', async () => {
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
  });

  await test.step('Kiểm tra đã vào Dashboard', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
`;

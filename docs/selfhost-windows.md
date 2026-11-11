# Self-host trên Windows — KHÔNG Docker (1 host: web + server + runner)

> Thay thế cho mục "P0 self-host / Docker" trong `13-devops/deployment.md`.
> Máy không có Docker (NO_DOCKER đã xác nhận) → chạy trực tiếp bằng Node + pnpm.
> Đã kiểm chứng trên Windows + Node v20 + pnpm 9.

## 1. Kiến trúc 1 host

```text
Windows host (PowerShell)
├─ apps/web     Vite dev  :5173  (prod: `vite build` → serve dist/)
├─ apps/server  Fastify   :3001  (/api/v1 + /ws + /health)
├─ apps/runner  worker trong tiến trình server (RunQueue, MAX_CONCURRENT_RUNS=2)
├─ SQLite file  DATABASE_URL=file:C:/vv-data/app.db   (Prisma, giữ tương thích Postgres)
└─ Artifacts    STORAGE_PATH=C:/vv-data/storage
                └─ runs/<run-id>/{result.json,trace.zip,video.webm,screenshots/}
```

DB là nguồn sự thật (authoritative): client WS mất kết nối → tự refetch
`GET /runs/:id` (xem `apps/web/src/hooks/useRunChannel.ts`).

## 2. Cài đặt lần đầu (PowerShell)

```powershell
# 0. Yêu cầu: Node 20+ và pnpm 9+
node --version; pnpm --version

# 1. Cài deps toàn workspace
pnpm install

# 2. Env
Copy-Item .env.example .env
notepad .env   # sửa DATABASE_URL, SECRET_*, STORAGE_PATH (xem §3)

# 3. DB: tạo SQLite + sinh client
pnpm db:push
pnpm db:generate

# 4. Trình duyệt cho runner (P0 chỉ cần chromium)
npx playwright install chromium

# 5. Build các package dùng chung (runner/web/server phụ thuộc vào dist/)
pnpm --filter @playwright-studio/reporter build
pnpm --filter @vv/recorder build
pnpm --filter @playwright-studio/runner build

# 6. Chạy dev (3 terminal riêng, xem §4 để chạy nền 24/7)
pnpm --filter @vv/server dev        # :3001
pnpm --filter @playwright-studio/web dev   # :5173
# runner là thư viện được server gọi qua RunQueue — không cần tiến trình riêng ở P0

# 7. Kiểm tra sức khỏe
pnpm health
```

## 3. Biến môi trường (đủ bộ)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | File SQLite. Self-host: dùng **đường dẫn tuyệt đối** `file:C:/vv-data/app.db` |
| `PORT` | `3001` | Cổng API server |
| `SERVER_SECRET_KEY` / `SECRET_ENCRYPTION_KEY` | — | Key base64 32-byte mã hóa biến secret (AES-256-GCM). **Bắt buộc đổi** |
| `APP_SECRET` | — | Ký session/token nội bộ. **Bắt buộc đổi** |
| `STORAGE_PATH` / `STORAGE_ROOT` | `./storage` | Gốc artifacts. Self-host: `C:/vv-data/storage` |
| `MAX_CONCURRENT_RUNS` / `RUNNER_MAX_CONCURRENT` | `2` | Số run Playwright song song (P0 1–2; recorder không chiếm pool này) |
| `ARTIFACT_RETENTION_DAYS` | `30` | Giữ artifacts 14–30 ngày (spec). Dọn bằng `pnpm cleanup` |
| `VITE_API_BASE` | `http://localhost:3001/api/v1` | Web trỏ tới API (build-time) |

Tạo key 32-byte trên PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

## 4. Chạy 24/7 trên 1 host (không Docker)

Dùng Task Scheduler, mỗi tác vụ "At startup":

| Task | Program | Arguments | Start in |
|---|---|---|---|
| vv-server | `node.exe` | `dist/index.js` | `D:\VietVang\Project\playwright-vv\apps\server` |
| vv-web | `node.exe` (serve) hoặc IIS | `serve -s dist -l 5173` | `...\apps\web` |
| vv-cleanup (hàng đêm) | `node.exe` | `..\..\scripts\cleanup-artifacts.mjs` | repo root |

Build prod trước: `pnpm build`, rồi `node dist/index.js` (server, entry duy nhất —
listen + boot recovery + scheduler ticker) +
phục vụ `apps/web/dist/` bằng `serve`/IIS.

> Ghi chú quyền: tài khoản chạy vv-server phải có quyền **SeDebugPrivilege**
> nếu muốn `taskkill /PID <pid> /T /F` kill được cây tiến trình Playwright
> (mặc định admin/local system có; user thường chỉ kill được tiến trình
> của chính mình — đủ cho P0 vì runner là tiến trình con của server).

## 5. SQLite + artifact volumes = thư mục nào

```powershell
$env:STORAGE_PATH = 'C:/vv-data/storage'
$env:DATABASE_URL = 'file:C:/vv-data/app.db'
New-Item -ItemType Directory -Force C:/vv-data/storage/runs | Out-Null
```

- `C:/vv-data/app.db*` — database (kèm `-journal`/`-wal` khi chạy).
- `C:/vv-data/storage/runs/<run-id>/` — `result.json`, `trace.zip`,
  `video.webm`, `screenshots/`. Temp build (`spec`, `config`) nằm ở
  `%TEMP%/pw-studio-runs/<run-id>-*/` và **tự xóa sau mỗi run** (step 8),
  artifacts được giữ lại.

## 6. Backup / restore

```powershell
# Backup (dừng server 5s để SQLite checkpoint cho sạch, hoặc copy -wal kèm theo)
Stop-ScheduledTask -TaskName vv-server
$stamp = Get-Date -Format yyyyMMdd-HHmm
Copy-Item C:/vv-data/app.db "C:/vv-backup/app-$stamp.db"
robocopy C:/vv-data/storage "C:/vv-backup/storage-$stamp" /MIR /XD node_modules
Start-ScheduledTask -TaskName vv-server

# Restore
Stop-ScheduledTask -TaskName vv-server
Copy-Item "C:/vv-backup/app-<stamp>.db" C:/vv-data/app.db -Force
robocopy "C:/vv-backup/storage-<stamp>" C:/vv-data/storage /MIR
Start-ScheduledTask -TaskName vv-server

# Kiểm tra sau restore
pnpm health
```

## 7. Recovery đã verify (Day 8-10)

| Tình huống | Hành vi (đã có test) |
|---|---|
| Cancel run | Kill **cả cây** (`taskkill /PID /T /F` Win, `kill(-pid)` POSIX) → step dở `skipped`, run `cancelled`, phát `run.cancelled` (`apps/runner/src/run.ts`, `process.ts`) |
| Browser recorder chết | `POST /recorder/:sid/interrupt` → session `interrupted`, **giữ draft** (`packages/recorder/src/sessionManager.ts`, `GET /recorder/:sid` lấy lại draft) |
| Runner crash giữa chừng | Boot gọi `recoverIncompleteRuns(store)` → run kẹt `failed` + giữ artifacts (`apps/runner/src/recover.ts`) |
| Mất WS | Client refetch `GET /runs/:id` khi (re)connect + ở mọi event terminal (`useRunChannel.ts`; server: DB authoritative) |
| Timeout | Kế thừa Project→Test→Step, UI hiện nguồn (`resolveTimeouts().source` + `TimeoutSourceBadge` trong `Inspector.tsx`) |
| Artifacts quá hạn | `pnpm cleanup` / `cleanup:dry` theo `ARTIFACT_RETENTION_DAYS` |

Tests: `pnpm --filter @playwright-studio/runner test` (12),
`pnpm --filter @vv/recorder test` (4).

## 8. Troubleshooting

| Triệu chứng | Nguyên nhân → sửa |
|---|---|
| `:3001` ECONNREFUSED / port đã dùng | `Get-NetTCPConnection -LocalPort 3001` tìm PID → `Stop-Process -Id <pid>`; hoặc đổi `PORT` |
| `:5173` trắng trang | Web chưa `pnpm dev` / sai `VITE_API_BASE` (build-time — sửa xong phải build lại) |
| `playwright install chromium` lỗi thiếu dep | Windows: cài **Visual C++ Redistributable** + chạy `npx playwright install chromium`; Linux mới cần `--with-deps` |
| Cancel không chết browser | User chạy server không có quyền kill tiến trình con → chạy Task Scheduler bằng cùng user khởi runner, hoặc admin |
| `taskkill` báo Access Denied | Thiếu quyền trên cây tiến trình (xem §4) |
| Artifacts phình đĩa | Giảm `ARTIFACT_RETENTION_DAYS=14` + đặt lịch `pnpm cleanup` hàng đêm; `cleanup:dry` để xem trước |
| DB locked (SQLite busy) | 2 tiến trình cùng mở file dev.db → chỉ chạy 1 server; self-host dùng đường dẫn tuyệt đối duy nhất |
| WS cứ reconnecting | Server chưa chạy / firewall chặn :3001 → client vẫn refetch DB khi nối lại, không mất trạng thái |

## 9. Lệnh verify từng phần

```powershell
pnpm --filter @playwright-studio/runner build   # build runner (gồm recover/retention mới)
pnpm --filter @playwright-studio/runner test    # 12 tests: cancel/interrupt/retention/timeout
pnpm --filter @vv/recorder test                 # 4 tests: browser-death interrupt giữ draft
pnpm cleanup:dry                                # xem artifacts quá hạn (không xóa)
pnpm cleanup                                    # xóa thật theo ARTIFACT_RETENTION_DAYS
pnpm health                                     # API :3001 + web :5173 + storage + sqlite + chromium
```

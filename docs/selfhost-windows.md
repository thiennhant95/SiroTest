# Self-host trÃªn Windows â€” KHÃ”NG Docker (1 host: web + server + runner)

> Thay tháº¿ cho má»¥c "P0 self-host / Docker" trong `spec/13-devops/deployment.md`.
> MÃ¡y khÃ´ng cÃ³ Docker (NO_DOCKER Ä‘Ã£ xÃ¡c nháº­n) â†’ cháº¡y trá»±c tiáº¿p báº±ng Node + pnpm.
> ÄÃ£ kiá»ƒm chá»©ng trÃªn Windows + Node v20 + pnpm 9.

## 1. Kiáº¿n trÃºc 1 host

```text
Windows host (PowerShell)
â”œâ”€ apps/web     Vite dev  :5173  (prod: `vite build` â†’ serve dist/)
â”œâ”€ apps/server  Fastify   :3001  (/api/v1 + /ws + /health)
â”œâ”€ apps/runner  worker trong tiáº¿n trÃ¬nh server (RunQueue, MAX_CONCURRENT_RUNS=2)
â”œâ”€ SQLite file  DATABASE_URL=file:C:/vv-data/app.db   (Prisma, giá»¯ tÆ°Æ¡ng thÃ­ch Postgres)
â””â”€ Artifacts    STORAGE_PATH=C:/vv-data/storage
                â””â”€ runs/<run-id>/{result.json,trace.zip,video.webm,screenshots/}
```

DB lÃ  nguá»“n sá»± tháº­t (authoritative): client WS máº¥t káº¿t ná»‘i â†’ tá»± refetch
`GET /runs/:id` (xem `apps/web/src/hooks/useRunChannel.ts`).

## 2. CÃ i Ä‘áº·t láº§n Ä‘áº§u (PowerShell)

```powershell
# 0. YÃªu cáº§u: Node 20+ vÃ  pnpm 9+
node --version; pnpm --version

# 1. CÃ i deps toÃ n workspace
pnpm install

# 2. Env
Copy-Item .env.example .env
notepad .env   # sá»­a DATABASE_URL, SECRET_*, STORAGE_PATH (xem Â§3)

# 3. DB: táº¡o SQLite + sinh client
pnpm db:push
pnpm db:generate

# 4. TrÃ¬nh duyá»‡t cho runner (P0 chá»‰ cáº§n chromium)
npx playwright install chromium

# 5. Build cÃ¡c package dÃ¹ng chung (runner/web/server phá»¥ thuá»™c vÃ o dist/)
pnpm --filter @playwright-studio/reporter build
pnpm --filter @vv/recorder build
pnpm --filter @playwright-studio/runner build

# 6. Cháº¡y dev (3 terminal riÃªng, xem Â§4 Ä‘á»ƒ cháº¡y ná»n 24/7)
pnpm --filter @vv/server dev        # :3001
pnpm --filter @playwright-studio/web dev   # :5173
# runner lÃ  thÆ° viá»‡n Ä‘Æ°á»£c server gá»i qua RunQueue â€” khÃ´ng cáº§n tiáº¿n trÃ¬nh riÃªng á»Ÿ P0

# 7. Kiá»ƒm tra sá»©c khá»e
pnpm health
```

## 3. Biáº¿n mÃ´i trÆ°á»ng (Ä‘á»§ bá»™)

| Biáº¿n | Máº·c Ä‘á»‹nh | Ã nghÄ©a |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | File SQLite. Self-host: dÃ¹ng **Ä‘Æ°á»ng dáº«n tuyá»‡t Ä‘á»‘i** `file:C:/vv-data/app.db` |
| `PORT` | `3001` | Cá»•ng API server |
| `SERVER_SECRET_KEY` / `SECRET_ENCRYPTION_KEY` | â€” | Key base64 32-byte mÃ£ hÃ³a biáº¿n secret (AES-256-GCM). **Báº¯t buá»™c Ä‘á»•i** |
| `APP_SECRET` | â€” | KÃ½ session/token ná»™i bá»™. **Báº¯t buá»™c Ä‘á»•i** |
| `STORAGE_PATH` / `STORAGE_ROOT` | `./storage` | Gá»‘c artifacts. Self-host: `C:/vv-data/storage` |
| `MAX_CONCURRENT_RUNS` / `RUNNER_MAX_CONCURRENT` | `2` | Sá»‘ run Playwright song song (P0 1â€“2; recorder khÃ´ng chiáº¿m pool nÃ y) |
| `ARTIFACT_RETENTION_DAYS` | `30` | Giá»¯ artifacts 14â€“30 ngÃ y (spec). Dá»n báº±ng `pnpm cleanup` |
| `VITE_API_BASE` | `http://localhost:3001/api/v1` | Web trá» tá»›i API (build-time) |

Táº¡o key 32-byte trÃªn PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

## 4. Cháº¡y 24/7 trÃªn 1 host (khÃ´ng Docker)

DÃ¹ng Task Scheduler, má»—i tÃ¡c vá»¥ "At startup":

| Task | Program | Arguments | Start in |
|---|---|---|---|
| vv-server | `node.exe` | `dist/index.js` | `C:\SiroTest\apps\server` |
| vv-web | `node.exe` (serve) hoáº·c IIS | `serve -s dist -l 5173` | `...\apps\web` |
| vv-cleanup (hÃ ng Ä‘Ãªm) | `node.exe` | `..\..\scripts\cleanup-artifacts.mjs` | repo root |

Build prod trÆ°á»›c: `pnpm build`, rá»“i `node dist/index.js` (server, entry duy nháº¥t â€”
listen + boot recovery + scheduler ticker) +
phá»¥c vá»¥ `apps/web/dist/` báº±ng `serve`/IIS.

> Ghi chÃº quyá»n: tÃ i khoáº£n cháº¡y vv-server pháº£i cÃ³ quyá»n **SeDebugPrivilege**
> náº¿u muá»‘n `taskkill /PID <pid> /T /F` kill Ä‘Æ°á»£c cÃ¢y tiáº¿n trÃ¬nh Playwright
> (máº·c Ä‘á»‹nh admin/local system cÃ³; user thÆ°á»ng chá»‰ kill Ä‘Æ°á»£c tiáº¿n trÃ¬nh
> cá»§a chÃ­nh mÃ¬nh â€” Ä‘á»§ cho P0 vÃ¬ runner lÃ  tiáº¿n trÃ¬nh con cá»§a server).

## 5. SQLite + artifact volumes = thÆ° má»¥c nÃ o

```powershell
$env:STORAGE_PATH = 'C:/vv-data/storage'
$env:DATABASE_URL = 'file:C:/vv-data/app.db'
New-Item -ItemType Directory -Force C:/vv-data/storage/runs | Out-Null
```

- `C:/vv-data/app.db*` â€” database (kÃ¨m `-journal`/`-wal` khi cháº¡y).
- `C:/vv-data/storage/runs/<run-id>/` â€” `result.json`, `trace.zip`,
  `video.webm`, `screenshots/`. Temp build (`spec`, `config`) náº±m á»Ÿ
  `%TEMP%/pw-studio-runs/<run-id>-*/` vÃ  **tá»± xÃ³a sau má»—i run** (step 8),
  artifacts Ä‘Æ°á»£c giá»¯ láº¡i.

## 6. Backup / restore

```powershell
# Backup (dá»«ng server 5s Ä‘á»ƒ SQLite checkpoint cho sáº¡ch, hoáº·c copy -wal kÃ¨m theo)
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

# Kiá»ƒm tra sau restore
pnpm health
```

## 7. Recovery Ä‘Ã£ verify (Day 8-10)

| TÃ¬nh huá»‘ng | HÃ nh vi (Ä‘Ã£ cÃ³ test) |
|---|---|
| Cancel run | Kill **cáº£ cÃ¢y** (`taskkill /PID /T /F` Win, `kill(-pid)` POSIX) â†’ step dá»Ÿ `skipped`, run `cancelled`, phÃ¡t `run.cancelled` (`apps/runner/src/run.ts`, `process.ts`) |
| Browser recorder cháº¿t | `POST /recorder/:sid/interrupt` â†’ session `interrupted`, **giá»¯ draft** (`packages/recorder/src/sessionManager.ts`, `GET /recorder/:sid` láº¥y láº¡i draft) |
| Runner crash giá»¯a chá»«ng | Boot gá»i `recoverIncompleteRuns(store)` â†’ run káº¹t `failed` + giá»¯ artifacts (`apps/runner/src/recover.ts`) |
| Máº¥t WS | Client refetch `GET /runs/:id` khi (re)connect + á»Ÿ má»i event terminal (`useRunChannel.ts`; server: DB authoritative) |
| Timeout | Káº¿ thá»«a Projectâ†’Testâ†’Step, UI hiá»‡n nguá»“n (`resolveTimeouts().source` + `TimeoutSourceBadge` trong `Inspector.tsx`) |
| Artifacts quÃ¡ háº¡n | `pnpm cleanup` / `cleanup:dry` theo `ARTIFACT_RETENTION_DAYS` |

Tests: `pnpm --filter @playwright-studio/runner test` (12),
`pnpm --filter @vv/recorder test` (4).

## 8. Troubleshooting

| Triá»‡u chá»©ng | NguyÃªn nhÃ¢n â†’ sá»­a |
|---|---|
| `:3001` ECONNREFUSED / port Ä‘Ã£ dÃ¹ng | `Get-NetTCPConnection -LocalPort 3001` tÃ¬m PID â†’ `Stop-Process -Id <pid>`; hoáº·c Ä‘á»•i `PORT` |
| `:5173` tráº¯ng trang | Web chÆ°a `pnpm dev` / sai `VITE_API_BASE` (build-time â€” sá»­a xong pháº£i build láº¡i) |
| `playwright install chromium` lá»—i thiáº¿u dep | Windows: cÃ i **Visual C++ Redistributable** + cháº¡y `npx playwright install chromium`; Linux má»›i cáº§n `--with-deps` |
| Cancel khÃ´ng cháº¿t browser | User cháº¡y server khÃ´ng cÃ³ quyá»n kill tiáº¿n trÃ¬nh con â†’ cháº¡y Task Scheduler báº±ng cÃ¹ng user khá»Ÿi runner, hoáº·c admin |
| `taskkill` bÃ¡o Access Denied | Thiáº¿u quyá»n trÃªn cÃ¢y tiáº¿n trÃ¬nh (xem Â§4) |
| Artifacts phÃ¬nh Ä‘Ä©a | Giáº£m `ARTIFACT_RETENTION_DAYS=14` + Ä‘áº·t lá»‹ch `pnpm cleanup` hÃ ng Ä‘Ãªm; `cleanup:dry` Ä‘á»ƒ xem trÆ°á»›c |
| DB locked (SQLite busy) | 2 tiáº¿n trÃ¬nh cÃ¹ng má»Ÿ file dev.db â†’ chá»‰ cháº¡y 1 server; self-host dÃ¹ng Ä‘Æ°á»ng dáº«n tuyá»‡t Ä‘á»‘i duy nháº¥t |
| WS cá»© reconnecting | Server chÆ°a cháº¡y / firewall cháº·n :3001 â†’ client váº«n refetch DB khi ná»‘i láº¡i, khÃ´ng máº¥t tráº¡ng thÃ¡i |

## 9. Lá»‡nh verify tá»«ng pháº§n

```powershell
pnpm --filter @playwright-studio/runner build   # build runner (gá»“m recover/retention má»›i)
pnpm --filter @playwright-studio/runner test    # 12 tests: cancel/interrupt/retention/timeout
pnpm --filter @vv/recorder test                 # 4 tests: browser-death interrupt giá»¯ draft
pnpm cleanup:dry                                # xem artifacts quÃ¡ háº¡n (khÃ´ng xÃ³a)
pnpm cleanup                                    # xÃ³a tháº­t theo ARTIFACT_RETENTION_DAYS
pnpm health                                     # API :3001 + web :5173 + storage + sqlite + chromium
```

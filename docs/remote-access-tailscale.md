# Self-hosting SiroTest (Windows or Linux)

> Audience: the one person who installs the server. Testers and BRSEs never read this — they only open a URL.
> Verified on Windows 10/11 + Node 20 + pnpm 9. Linux works the same (bash instead of PowerShell).

## 0. Architecture (30 seconds)

```
Server host (office PC, wired network, never sleeps)
├─ SiroTest web UI    :5173   (users open this)
├─ SiroTest API       :3001   (/api/v1 + /ws)
├─ Runner             in-process workers (MAX_CONCURRENT_RUNS, default 2)
├─ SQLite             file:<data-dir>/app.db  (Prisma, Postgres-compatible)
└─ Artifacts          file:<data-dir>/storage/runs/<run-id>/…
```

Remote teammates reach it over **Tailscale** (no router ports). The database is the
source of truth: the UI only shows the latest state it fetched.

## 1. Prerequisites

| Item | Requirement |
|---|---|
| OS | Windows 10/11 or Linux (x64) |
| Runtime | Node.js 20 LTS + pnpm 9 (`corepack prepare pnpm@9.0.0 --activate`) |
| RAM / disk | 8 GB+ (16 GB for two parallel runs) / 50 GB free |
| Network | Wired, always-on, sleep disabled |
| Secrets | `SECRET_ENCRYPTION_KEY` = base64 of 32 random bytes (encrypts secret variables) |

Generate the key once:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

## 2. Install

```powershell
git clone https://github.com/thiennhant95/SiroTest.git C:\SiroTest
cd C:\SiroTest
pnpm install
npx prisma generate
npx playwright install chromium
```

Create the database (first time only):

```powershell
$env:DATABASE_URL='file:C:/SiroTest/data/app.db'
npx prisma db push --skip-generate
```

## 3. Configure (once per host)

`setx` persists the values for the service user. Never commit these to git.

```powershell
setx SECRET_ENCRYPTION_KEY "<base64-32-bytes>"
setx VV_AI_API_KEY "<your OpenAI-compatible key, optional>"
```

Environment variables read at start:

| Variable | Purpose | Example |
|---|---|---|
| `PORT` | API port | `3001` |
| `DATABASE_URL` | SQLite file | `file:C:/SiroTest/data/app.db` |
| `SECRET_ENCRYPTION_KEY` | AES-256-GCM key for secrets at rest | base64 (32 bytes) |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Optional LLM gateway | `https://gateway.internal/v1` |
| `MAX_CONCURRENT_RUNS` | Parallel runs per host | `2` |
| `ALLOW_DEV_AUTH` | Dev login bypass — **`0` on any networked host** | `0` |
| `ALLOW_PRIVATE_TARGETS` | Allow private-IP targets (local E2E only) | unset publicly |
| `CORS_ALLOWED_ORIGINS` | Allowed web origins | `http://127.0.0.1:5173` |

## 4. Start

Local mode (Dev login enabled, web on localhost):

```powershell
powershell -ExecutionPolicy Bypass -File start-tool.ps1
```

Networked mode (Dev login disabled, web bound to all interfaces):

```powershell
powershell -ExecutionPolicy Bypass -File start-tool.ps1 -Public
```

Expected output: `server ... 3001=True | web ... 5173=True | mode=PUBLIC (no Dev auth)`.

Logs: `%TEMP%\opencode\vv-server.log` and `vv-web.log`.

## 5. Run it as a service (survives reboot)

A normal background process dies when the SSH/RDP session closes. Use a scheduled
task instead:

```powershell
echo powershell -NoProfile -ExecutionPolicy Bypass -File C:\SiroTest\start-tool.ps1 -Public > C:\SiroTest\start-hub.cmd
schtasks /create /tn SiroTestHub /tr C:\SiroTest\start-hub.cmd /sc onlogon /f
schtasks /run /tn SiroTestHub
```

> `onlogon` requires someone to log in after a reboot. Enable auto-logon for the
> service user, or switch the trigger to *At startup* and run as SYSTEM (then pin
> `DATABASE_URL` to an absolute path and make sure the browser binaries are under
> the SYSTEM profile or a shared `PLAYWRIGHT_BROWSERS_PATH`).

## 6. Remote access for teammates (Tailscale)

1. Install Tailscale on the server and on each teammate's machine, log in with the
   company account.
2. Approve new devices in the Tailscale admin console if prompted.
3. Read the server's tailnet IP: `tailscale ip -4` (e.g. `100.x.y.z`).
4. Teammates open `http://100.x.y.z:5173`, click **Sign up**, then tell the admin.
5. Admin grants project access (see §7). Reload → projects appear.

## 7. Accounts and permissions

Sign-up creates a user but no project membership. Grant one of:

| Role | Can | Cannot |
|---|---|---|
| viewer | Read everything, run tests | Create/edit/delete |
| editor | Everything a viewer can + author/run | Delete a project |
| owner | Everything | — |

Until an invite UI ships, grant membership with the helper (writes the DB directly,
no audit row):

```powershell
$env:DATABASE_URL='file:C:/SiroTest/data/app.db'
node scripts/add-member.mjs teammate@company.com editor
```

`node scripts/add-member.mjs teammate@company.com viewer <projectId>` targets a
specific project; the default is the first project in the database.

## 8. Security checklist

- `ALLOW_DEV_AUTH=0` on any host reachable from the network (the Dev tab is a bypass).
- Only Tailscale (or a VPN / Cloudflare Access) — never NAT ports 3001/5173 to the internet.
- Rotate `AI_API_KEY` / integration keys if they ever leak, then re-run `setx`.
- Secrets live encrypted in SQLite; the API never returns plaintext after creation.

## 9. Operations

| Task | Command |
|---|---|
| Restart | re-run `start-tool.ps1` (it kills stale listeners first) |
| Backup | copy `app.db` **with its `-wal` and `-shm` files** while the server is stopped |
| Update | `git pull` → `pnpm install` → `npx prisma generate` → restart |
| Audit | open **Audit** in the UI (every state change is recorded) |
| Retention | `pnpm cleanup:dry` then `pnpm cleanup` (artifacts + old runs) |

> SQLite runs in WAL mode: a bare `.db` copy taken while the server is running can
> miss recent transactions. Stop the server or use the three-file copy.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Teammate times out on the tailnet IP | Tailscale not logged in / not approved | Check both clients, approve in admin |
| `@prisma/client did not initialize yet` | client stub after install | `npx prisma generate` then restart |
| Server starts then exits silently | process tied to the SSH session | use the scheduled task (§5) |
| API returns 401 for `tester-1` | `-Public` mode (correct) | sign up instead of Dev login |
| Runs stay `queued` | worker slots busy / stale run | wait, cancel old runs, check logs |
| Videos won't load over a slow link | large artifact | wait, or use Download |
| No project after sign-up | no membership | §7 |

## 11. When to leave Tailscale

More than ~30 users, or a customer security review: move to Cloudflare Tunnel +
Access (company SSO). The app does not change — only the front door does.

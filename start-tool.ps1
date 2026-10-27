# start-tool.ps1 — one-double-click starter for the pilot stack.
#
#   ONE-TIME per machine (persisted, run once as the service user):
#     setx SECRET_ENCRYPTION_KEY "oW7gm2...<paste>"
#     setx VV_AI_API_KEY "sk-bob-...<paste>"
#   (get values from the team lead — never commit them to git)
#
#   Local (tester on this machine):   powershell -ExecutionPolicy Bypass -File start-tool.ps1
#   Exposed (BRSE over Tailscale):    powershell -ExecutionPolicy Bypass -File start-tool.ps1 -Public
#
# -Public switches the server to remote-safe mode (ALLOW_DEV_AUTH=0, no Dev
# tab bypass) and binds the web UI to all interfaces so tailnet peers can
# reach http://<this-host-tailnet-ip>:5173. Default local mode keeps Dev auth
# for tester-1 and binds web to localhost only.
# Logs: $env:TEMP\opencode\vv-server.log / vv-web.log
param([switch]$Public)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:TEMP 'opencode'
New-Item -ItemType Directory -Path $log -Force | Out-Null

$env:PORT = '3001'
$env:DATABASE_URL = 'file:D:/VietVang/Project/playwright-vv/apps/server/pilot-mizoguchi.db'
$env:SECRET_ENCRYPTION_KEY = if ($env:SECRET_ENCRYPTION_KEY) { $env:SECRET_ENCRYPTION_KEY } else { throw 'SECRET_ENCRYPTION_KEY missing — run the one-time setx first (see header)' }
$env:MAX_CONCURRENT_RUNS = '2'
$env:ALLOW_PRIVATE_TARGETS = '1'
$env:CORS_ALLOWED_ORIGINS = 'http://127.0.0.1:5173'
$env:AI_BASE_URL = 'https://gemini.vietvang.net/v1'
$env:AI_API_KEY = if ($env:VV_AI_API_KEY) { $env:VV_AI_API_KEY } else { '' }
$env:AI_MODEL = 'gemini-2.5-flash'
if ($Public) { $env:ALLOW_DEV_AUTH = '0' } else { $env:ALLOW_DEV_AUTH = '1' }

# Kill anything already on the ports (stale runs leave listeners behind).
foreach ($p in @(3001, 5173)) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
}
Start-Sleep -Seconds 2

$srv = Start-Process -FilePath 'npx.cmd' -ArgumentList 'tsx','src/index.ts' `
  -WorkingDirectory (Join-Path $root 'apps\server') `
  -RedirectStandardOutput (Join-Path $log 'vv-server.log') `
  -RedirectStandardError (Join-Path $log 'vv-server.err.log') `
  -WindowStyle Hidden -PassThru
$webArgs = @('vite','--port','5173','--strictPort')
if ($Public) { $webArgs += @('--host','0.0.0.0') }
$web = Start-Process -FilePath 'npx.cmd' -ArgumentList $webArgs `
  -WorkingDirectory (Join-Path $root 'apps\web') `
  -RedirectStandardOutput (Join-Path $log 'vv-web.log') `
  -RedirectStandardError (Join-Path $log 'vv-web.err.log') `
  -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 12
$a = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3001 -WarningAction SilentlyContinue).TcpTestSucceeded
$b = (Test-NetConnection -ComputerName 127.0.0.1 -Port 5173 -WarningAction SilentlyContinue).TcpTestSucceeded
"server PID=$($srv.Id) 3001=$a | web PID=$($web.Id) 5173=$b | mode=$(if ($Public) { 'PUBLIC (no Dev auth)' } else { 'LOCAL (Dev auth on)' })"

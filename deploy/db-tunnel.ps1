# Open an SSH tunnel from a local port to the someting Postgres on the VPS.
#
# Postgres is published on the VPS loopback at 127.0.0.1:15432 (see
# compose.yaml). This script just forwards a local port through SSH to that
# loopback address — no Docker inspection needed.
#
# Defaults to local port 15432 to coexist with other tunnels (e.g. a 5432
# tunnel to a different VPS). Uses `-S none` so this session won't share or
# collide with any active ControlMaster connection to the same host.
#
# Connect with any psql client to:
#   postgres://<user>:<pw>@127.0.0.1:15432/<db>
#
# Env: SOMETING_VPS_HOST, SOMETING_VPS_USER, SOMETING_SSH_KEY

param(
  [int]$LocalPort = 15432,
  [int]$RemotePort = 15432,
  [string]$Db = "someting",
  [string]$DbUser = "someting",
  [string]$HostName = $(if ($env:SOMETING_VPS_HOST) { $env:SOMETING_VPS_HOST } else { "95.217.223.133" }),
  [string]$User = $(if ($env:SOMETING_VPS_USER) { $env:SOMETING_VPS_USER } else { "root" }),
  [string]$IdentityFile = $(if ($env:SOMETING_SSH_KEY) { $env:SOMETING_SSH_KEY } else { "$env:USERPROFILE\.ssh\allio_hetzner" }),
  [string]$RemoteEnvFile = "/opt/someting/.env"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdentityFile)) {
  throw "SSH identity file not found: $IdentityFile`nSet env SOMETING_SSH_KEY or pass -IdentityFile."
}

$remote = "${User}@${HostName}"

$busy = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  throw "Local port $LocalPort is already in use. Pass -LocalPort with a free port."
}

# Fetch POSTGRES_PASSWORD from the VPS's .env so we can print a ready URL.
# Only meaningful for the bootstrap `someting` superuser — other roles have
# their own passwords not stored in this file.
$password = $null
if ($DbUser -eq "someting") {
  try {
    $envLine = & ssh -i $IdentityFile -o BatchMode=yes -o "ControlMaster=no" -o "ControlPath=none" `
      $remote "grep -E '^POSTGRES_PASSWORD=' $RemoteEnvFile"
    if ($LASTEXITCODE -eq 0 -and $envLine) {
      $password = ($envLine -split '=', 2)[1].Trim().Trim("'").Trim('"')
    }
  } catch {
    # Non-fatal — we'll just print a placeholder.
  }
}

$pwDisplay = if ($password) { $password } else { "<password>" }
$url = "postgres://${DbUser}:${pwDisplay}@127.0.0.1:${LocalPort}/${Db}"

Write-Host "Opening tunnel:  127.0.0.1:$LocalPort  ->  ${remote}:127.0.0.1:$RemotePort"
Write-Host "Connect with:    $url"
Write-Host "Press Ctrl+C to close the tunnel."
Write-Host ""

# -N: no remote command, -T: no TTY, -S none + ControlMaster=no: don't share
# with another active session to the same host. ServerAlive keeps NAT entries warm.
& ssh `
  -i $IdentityFile `
  -N -T `
  -S none `
  -o "ControlMaster=no" `
  -o "ControlPath=none" `
  -o "ExitOnForwardFailure=yes" `
  -o "ServerAliveInterval=30" `
  -o "ServerAliveCountMax=3" `
  -L "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}" `
  $remote

exit $LASTEXITCODE

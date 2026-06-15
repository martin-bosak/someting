<#
  Back up the whole Someting platform from this local Windows host.

  Produces a timestamped folder under _BACKUP/ with three parts:

    1) Postgres        -> _BACKUP/<stamp>/postgres/<db>.dump (or .sql.gz fallback)
                          Dumped over a local SSH tunnel to the VPS loopback
                          Postgres (127.0.0.1:15432). Falls back to running
                          pg_dump inside the container over SSH if a local
                          pg_dump is missing or version-incompatible.

    2) Deployed code   -> _BACKUP/<stamp>/deployed/sites-code.tar.gz
                          The /srv/hosting/sites tree (releases + per-site
                          config), excluding node_modules and the persistent
                          'shared' volumes (those are part 3).
                       -> _BACKUP/<stamp>/deployed/caddy.tar.gz
                          Caddy routes + config + TLS certs (excludes access logs).

    3) Mounted volumes -> _BACKUP/<stamp>/sites/<slug>/volume.tar.gz
                          Each site's persistent shared/ storage (the /data mount).

  Env defaults match the other deploy/*.ps1 scripts:
    SOMETING_VPS_HOST, SOMETING_VPS_USER, SOMETING_SSH_KEY

  Examples:
    powershell -ExecutionPolicy Bypass -File deploy/backup-platform.ps1
    powershell -ExecutionPolicy Bypass -File deploy/backup-platform.ps1 -KeepBackups 7
    powershell -ExecutionPolicy Bypass -File deploy/backup-platform.ps1 -SkipPostgres
#>

param(
  [string]$HostName     = $(if ($env:SOMETING_VPS_HOST) { $env:SOMETING_VPS_HOST } else { "95.217.223.133" }),
  [string]$User         = $(if ($env:SOMETING_VPS_USER) { $env:SOMETING_VPS_USER } else { "root" }),
  [string]$IdentityFile = $(if ($env:SOMETING_SSH_KEY)  { $env:SOMETING_SSH_KEY }  else { "$env:USERPROFILE\.ssh\allio_hetzner" }),

  # Path of the hosting tree on the VPS host (HOSTING_ROOT_HOST in the VPS .env).
  [string]$RemoteHostingRoot = "/srv/hosting",
  # The control-plane .env on the VPS; used to read POSTGRES_* credentials.
  [string]$RemoteEnvFile     = "/opt/someting/.env",

  # Where backups land locally. Defaults to <repo>/_BACKUP.
  [string]$OutDir = "",

  # Local + remote ports for the Postgres tunnel. 15433 avoids clashing with a
  # db-tunnel.ps1 session already on 15432.
  [int]$LocalPort  = 15433,
  [int]$RemotePort = 15432,

  # Keep only the newest N backup folders (0 = keep everything).
  [int]$KeepBackups = 0,

  [switch]$SkipPostgres,
  [switch]$SkipDeployed,
  [switch]$SkipVolumes
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdentityFile)) {
  throw "SSH identity file not found: $IdentityFile`nSet env SOMETING_SSH_KEY or pass -IdentityFile."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $OutDir) { $OutDir = Join-Path $repoRoot "_BACKUP" }

$remote = "${User}@${HostName}"
$stamp  = Get-Date -Format "yyyy-MM-dd_HHmmss"
$dest   = Join-Path $OutDir $stamp
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Common ssh options: never prompt, never reuse a shared ControlMaster socket.
$sshBase = @("-i", $IdentityFile, "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none")

function Invoke-Remote([string]$cmd) {
  $out = & ssh @sshBase $remote $cmd 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Remote command failed (exit $LASTEXITCODE): $cmd`n$out"
  }
  return $out
}

function Get-RemoteEnvValue([string]$key, [string]$fallback) {
  try {
    $line = & ssh @sshBase $remote "grep -E '^$key=' '$RemoteEnvFile' 2>/dev/null | head -n1"
    if ($LASTEXITCODE -eq 0 -and $line) {
      return ($line -split "=", 2)[1].Trim().Trim("'").Trim('"')
    }
  } catch { }
  return $fallback
}

function Copy-RemoteTar {
  param(
    [string]$RemotePath,
    [string]$LocalFile,
    [string[]]$Excludes = @()
  )
  $clean  = $RemotePath.TrimEnd("/")
  $exists = (& ssh @sshBase $remote "test -d '$clean' && echo yes || echo no").Trim()
  if ($exists -ne "yes") {
    Write-Host "    - skip (not found): $clean"
    return $false
  }

  $parent = $clean -replace "/[^/]+$", ""
  if (-not $parent) { $parent = "/" }
  $leaf = ($clean -split "/")[-1]

  $rand      = [Guid]::NewGuid().ToString("N").Substring(0, 10)
  $remoteTar = "/tmp/someting-backup-$rand.tar.gz"
  $exArgs    = ($Excludes | ForEach-Object { "--exclude='$_'" }) -join " "

  try {
    Invoke-Remote "tar -czf '$remoteTar' -C '$parent' $exArgs '$leaf'" | Out-Null
    & scp @sshBase "${remote}:$remoteTar" "$LocalFile"
    if ($LASTEXITCODE -ne 0) { throw "scp failed for $clean" }
  }
  finally {
    & ssh @sshBase $remote "rm -f '$remoteTar'" 2>&1 | Out-Null
  }

  $size = (Get-Item -LiteralPath $LocalFile).Length
  Write-Host ("    - {0}  ({1:N1} MB)" -f (Split-Path $LocalFile -Leaf), ($size / 1MB))
  return $true
}

function Wait-PortOpen([int]$port, [int]$timeoutSec = 20) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect("127.0.0.1", $port)
      $client.Close()
      return $true
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return $false
}

$summary = [System.Collections.Generic.List[string]]::new()
$summary.Add("Someting backup $stamp")
$summary.Add("VPS: $remote   hosting root: $RemoteHostingRoot")
$summary.Add("")

Write-Host "=== Someting platform backup ==="
Write-Host "VPS:     $remote"
Write-Host "Output:  $dest"
Write-Host ""

# --- 1) Postgres ------------------------------------------------------------
if (-not $SkipPostgres) {
  Write-Host "[1/3] Postgres dump (via SSH tunnel)"
  $pgDir = Join-Path $dest "postgres"
  New-Item -ItemType Directory -Force -Path $pgDir | Out-Null

  $pgUser = Get-RemoteEnvValue "POSTGRES_USER" "someting"
  $pgDb   = Get-RemoteEnvValue "POSTGRES_DB" "someting"
  $pgPass = Get-RemoteEnvValue "POSTGRES_PASSWORD" ""

  $localPgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
  $done = $false

  if ($localPgDump) {
    $busy = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
    if ($busy) { throw "Local port $LocalPort is already in use. Pass -LocalPort with a free port." }

    $tunnelArgs = $sshBase + @(
      "-N", "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-L", "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}",
      $remote
    )
    $tunnel = Start-Process ssh -ArgumentList $tunnelArgs -PassThru -WindowStyle Hidden
    try {
      if (-not (Wait-PortOpen $LocalPort 20)) {
        throw "Tunnel did not open on 127.0.0.1:$LocalPort within 20s."
      }
      $outFile = Join-Path $pgDir "$pgDb.dump"
      $env:PGPASSWORD = $pgPass
      # Custom format (-Fc): compressed, restored with pg_restore.
      & pg_dump -h 127.0.0.1 -p $LocalPort -U $pgUser -Fc --no-owner --no-privileges -f "$outFile" $pgDb
      if ($LASTEXITCODE -ne 0) { throw "local pg_dump exited $LASTEXITCODE" }
      $sz = (Get-Item -LiteralPath $outFile).Length
      Write-Host ("    - {0}  ({1:N1} MB)" -f "$pgDb.dump", ($sz / 1MB))
      $summary.Add("postgres/$pgDb.dump  (pg_dump -Fc, via tunnel)")
      $done = $true
    }
    catch {
      Write-Warning "Local pg_dump failed ($($_.Exception.Message)). Falling back to in-container pg_dump over SSH."
    }
    finally {
      Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
      if ($tunnel -and -not $tunnel.HasExited) { $tunnel.Kill() }
    }
  }
  else {
    Write-Host "    - pg_dump not found locally; using in-container pg_dump over SSH."
  }

  if (-not $done) {
    $container = (& ssh @sshBase $remote "docker ps --filter name=postgres --format '{{.Names}}' | head -n1").Trim()
    if (-not $container) { $container = "someting-postgres-1" }
    $remoteDump = "/tmp/someting-pg-$stamp.sql.gz"
    try {
      Invoke-Remote "docker exec '$container' pg_dump -U '$pgUser' --no-owner --no-privileges '$pgDb' | gzip > '$remoteDump'" | Out-Null
      $outFile = Join-Path $pgDir "$pgDb.sql.gz"
      & scp @sshBase "${remote}:$remoteDump" "$outFile"
      if ($LASTEXITCODE -ne 0) { throw "scp of postgres dump failed" }
      $sz = (Get-Item -LiteralPath $outFile).Length
      Write-Host ("    - {0}  ({1:N1} MB)" -f "$pgDb.sql.gz", ($sz / 1MB))
      $summary.Add("postgres/$pgDb.sql.gz  (in-container pg_dump | gzip)")
    }
    finally {
      & ssh @sshBase $remote "rm -f '$remoteDump'" 2>&1 | Out-Null
    }
  }
}
else {
  Write-Host "[1/3] Postgres dump - skipped"
}

# --- 2) Deployed code + Caddy ----------------------------------------------
if (-not $SkipDeployed) {
  Write-Host "[2/3] Deployed code + Caddy config"
  $depDir = Join-Path $dest "deployed"
  New-Item -ItemType Directory -Force -Path $depDir | Out-Null

  $okSites = Copy-RemoteTar `
    -RemotePath "$RemoteHostingRoot/sites" `
    -LocalFile (Join-Path $depDir "sites-code.tar.gz") `
    -Excludes @("*/node_modules", "*/node_modules/*", "sites/*/shared", "sites/*/shared/*")
  if ($okSites) { $summary.Add("deployed/sites-code.tar.gz  ($RemoteHostingRoot/sites, no node_modules/shared)") }

  $okCaddy = Copy-RemoteTar `
    -RemotePath "$RemoteHostingRoot/caddy" `
    -LocalFile (Join-Path $depDir "caddy.tar.gz") `
    -Excludes @("caddy/data/access-*.log", "caddy/data/*.log")
  if ($okCaddy) { $summary.Add("deployed/caddy.tar.gz  (routes, config, TLS certs)") }
}
else {
  Write-Host "[2/3] Deployed code - skipped"
}

# --- 3) Per-site mounted volumes -------------------------------------------
if (-not $SkipVolumes) {
  Write-Host "[3/3] Per-site mounted volumes (shared/)"
  $slugsRaw = & ssh @sshBase $remote "ls -1 '$RemoteHostingRoot/sites' 2>/dev/null"
  $slugs = @()
  if ($LASTEXITCODE -eq 0 -and $slugsRaw) {
    $slugs = $slugsRaw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  }

  if ($slugs.Count -eq 0) {
    Write-Host "    - no sites found under $RemoteHostingRoot/sites"
  }
  foreach ($slug in $slugs) {
    if ($slug -notmatch "^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$") {
      Write-Host "    - skip (unexpected name): $slug"
      continue
    }
    $siteDir = Join-Path (Join-Path $dest "sites") $slug
    New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
    $ok = Copy-RemoteTar `
      -RemotePath "$RemoteHostingRoot/sites/$slug/shared" `
      -LocalFile (Join-Path $siteDir "volume.tar.gz")
    if ($ok) { $summary.Add("sites/$slug/volume.tar.gz") }
  }
}
else {
  Write-Host "[3/3] Volumes - skipped"
}

# --- Manifest + retention ---------------------------------------------------
$summary.Add("")
$summary.Add("Created: $(Get-Date -Format o)")
Set-Content -Path (Join-Path $dest "manifest.txt") -Value ($summary -join "`r`n") -Encoding UTF8

if ($KeepBackups -gt 0) {
  $folders = Get-ChildItem -LiteralPath $OutDir -Directory | Sort-Object Name -Descending
  if ($folders.Count -gt $KeepBackups) {
    $folders | Select-Object -Skip $KeepBackups | ForEach-Object {
      Write-Host "Pruning old backup: $($_.Name)"
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
  }
}

Write-Host ""
Write-Host "=== Backup complete ==="
Write-Host $dest

# Deploy this repository to the VPS without Git: tar local tree, scp, extract, docker compose.
# Preserves the remote .env (not uploaded from your machine).
#
# Defaults match deploy/upload-static-site.ps1.
# Env: SOMETING_VPS_HOST, SOMETING_VPS_USER, SOMETING_SSH_KEY, SOMETING_SYNC_REMOTE_DIR

param(
  [string]$HostName = $(if ($env:SOMETING_VPS_HOST) { $env:SOMETING_VPS_HOST } else { "95.217.223.133" }),
  [string]$User = $(if ($env:SOMETING_VPS_USER) { $env:SOMETING_VPS_USER } else { "root" }),
  [string]$IdentityFile = $(if ($env:SOMETING_SSH_KEY) { $env:SOMETING_SSH_KEY } else { "$env:USERPROFILE\.ssh\allio_hetzner" }),
  [string]$RemoteDir = $(if ($env:SOMETING_SYNC_REMOTE_DIR) { $env:SOMETING_SYNC_REMOTE_DIR } else { "/opt/someting" })
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdentityFile)) {
  throw "SSH identity file not found: $IdentityFile`nSet env SOMETING_SSH_KEY or pass -IdentityFile."
}

$rd = $RemoteDir.Trim()
if ($rd -notmatch '^/[a-zA-Z0-9/_.-]+$') {
  throw "RemoteDir must be an absolute posix path (/...)."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "compose.yaml"))) {
  throw "compose.yaml not found under $repoRoot"
}

$remote = "${User}@${HostName}"
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$archive = Join-Path $env:TEMP "someting-sync-$stamp.tar.gz"
$remoteArchive = "/tmp/someting-sync-$stamp.tar.gz"

Write-Host "Packing repo (excluding node_modules, runtime, dist, .git, .env)..."
Write-Host "Target: ${remote}:${rd}"

Push-Location $repoRoot
try {
  & tar.exe -czf $archive `
    --exclude="./node_modules" `
    --exclude="./runtime" `
    --exclude="./dist" `
    --exclude="./.git" `
    --exclude="./.env" `
    --exclude="./.cursor" `
    .
}
finally {
  Pop-Location
}

try {
  scp -i $IdentityFile $archive "${remote}:${remoteArchive}"

  # Remote script: LF only, ascii
  $remoteCmd = @'
set -euo pipefail
ARCH="__ARCH__"
RD="__RD__"
mkdir -p "$RD"
tar -xzf "$ARCH" -C "$RD"
rm -f "$ARCH"
cd "$RD"
if [ ! -f compose.yaml ]; then echo >&2 "compose.yaml missing in $PWD"; exit 1; fi
docker compose up -d --build
echo "Sync deploy finished."
'@
  $remoteCmd = $remoteCmd.Replace("__ARCH__", $remoteArchive).Replace("__RD__", $rd)
  $remoteCmd = $remoteCmd.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd() + "`n"

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $bytes = $utf8NoBom.GetBytes($remoteCmd)
  $b64 = [Convert]::ToBase64String($bytes)

  ssh -i $IdentityFile $remote "bash -lc 'echo $b64 | base64 -d | bash'"
  Write-Host "Done."
}
finally {
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
}

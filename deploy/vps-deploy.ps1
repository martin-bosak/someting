# Update the control-plane on the VPS over SSH.
#
# Tries multiple directories for a checkout with .git OR (with -SkipGitPull) compose.yaml → docker compose.
#
# -SkipGitPull | SOMETING_SKIP_GIT_PULL=1 : only docker compose, first dir that has compose.yaml.
#
# Env: SOMETING_VPS_HOST, SOMETING_VPS_USER, SOMETING_SSH_KEY, SOMETING_REMOTE_DIR
#      SOMETING_SKIP_GIT_PULL=1 | SOMETING_REMOTE_DIR_CANDIDATES=/a,/b

param(
  [string]$HostName = $(if ($env:SOMETING_VPS_HOST) { $env:SOMETING_VPS_HOST } else { "95.217.223.133" }),
  [string]$User = $(if ($env:SOMETING_VPS_USER) { $env:SOMETING_VPS_USER } else { "root" }),
  [string]$IdentityFile = $(if ($env:SOMETING_SSH_KEY) { $env:SOMETING_SSH_KEY } else { "$env:USERPROFILE\.ssh\allio_hetzner" }),
  [string]$RemoteDir = $(if ($env:SOMETING_REMOTE_DIR) { $env:SOMETING_REMOTE_DIR } else { "/opt/someting" }),
  [switch]$SkipGitPull
)

if ($env:SOMETING_SKIP_GIT_PULL -match '^(1|true|yes)$') {
  $SkipGitPull = $true
}

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdentityFile)) {
  throw "SSH identity file not found: $IdentityFile`nSet env SOMETING_SSH_KEY or pass -IdentityFile."
}

if ($RemoteDir -match '["$`!]') {
  throw "Use a simple REMOTE_DIR path without quotes, dollar, or backtick."
}

$rd = $RemoteDir.Trim()
if ($rd -notmatch '^/[a-zA-Z0-9/_.-]+$') {
  throw "SOMETING_REMOTE_DIR must be an absolute posix path (/...)."
}

$extra = @()
if ($env:SOMETING_REMOTE_DIR_CANDIDATES) {
  $extra = $env:SOMETING_REMOTE_DIR_CANDIDATES.Split(",") |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match "^/[a-zA-Z0-9/_.-]+$" }
}

$dirList = @(
  $rd
  "/opt/someting"
  "/root/someting"
  "/srv/hosting/someting"
  "/srv/hosting"
) + $extra | Select-Object -Unique

$dirsInner = ($dirList | ForEach-Object { "    $_" }) -join "`n"

$remote = "${User}@${HostName}"

if ($SkipGitPull) {
  Write-Host "SSH $remote - find compose.yaml - docker compose (no git)"
  $remoteCmd = @'
set -euo pipefail
candidates=(
__DIRS__
)
for d in "${candidates[@]}"; do
  [ -d "$d" ] || continue
  [ -f "$d/compose.yaml" ] || continue
  cd "$d"
  echo "Using (no git pull): $d"
  docker compose up -d --build
  echo "Control plane rebuilt."
  exit 0
done
echo >&2 "No compose.yaml found. Paths tried:"
printf ' %s\n' "${candidates[@]}" >&2
exit 1
'@
}
else {
  Write-Host "SSH $remote - try paths for .git - git pull - docker compose"
  $remoteCmd = @'
set -euo pipefail
candidates=(
__DIRS__
)
for d in "${candidates[@]}"; do
  [ -d "$d" ] || continue
  [ -d "$d/.git" ] || continue
  cd "$d"
  echo "Using: $d"
  git pull --ff-only
  docker compose up -d --build
  echo "Control plane rebuilt."
  exit 0
done
echo >&2 "No .git checkout in any searched path."
echo >&2 "Option A - clone once on the VPS, then re-run:"
echo >&2 '  mkdir -p /opt/someting && cd /opt/someting && git clone YOUR_REPO_HERE . && docker compose up -d --build'
echo >&2 "Option B - rebuild only without git: powershell deploy/vps-deploy.ps1 -SkipGitPull"
echo >&2 "Paths tried:"
printf ' %s\n' "${candidates[@]}" >&2
exit 1
'@
}

$remoteCmd = $remoteCmd.Replace("__DIRS__", $dirsInner)
$remoteCmd = $remoteCmd.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd() + "`n"

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$bytes = $utf8NoBom.GetBytes($remoteCmd)
$b64 = [Convert]::ToBase64String($bytes)

ssh -i $IdentityFile $remote "bash -lc 'echo $b64 | base64 -d | bash'"

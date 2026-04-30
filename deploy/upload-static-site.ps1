param(
  [Parameter(Mandatory = $true)]
  [string]$Slug,

  [Parameter(Mandatory = $true)]
  [string]$Path,

  [string]$Name = $Slug,
  [string]$HostName = "95.217.223.133",
  [string]$User = "root",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\allio_hetzner"
)

$ErrorActionPreference = "Stop"

if ($Slug -notmatch "^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$") {
  throw "Invalid slug. Use lowercase letters, numbers, and hyphens."
}

$source = Resolve-Path -LiteralPath $Path
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Path must be a folder: $Path"
}

$remote = "$User@$HostName"
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$archive = Join-Path $env:TEMP "someting-$Slug-$stamp.tar.gz"
$remoteArchive = "/tmp/someting-$Slug-$stamp.tar.gz"

try {
  tar -czf $archive -C $source .
  scp -i $IdentityFile $archive "${remote}:${remoteArchive}"
  ssh -i $IdentityFile $remote "bash /opt/someting/scripts/upload-static-site.sh '$Slug' '$remoteArchive' '$Name' && rm -f '$remoteArchive'"
  Write-Host "Uploaded $source to site '$Slug'."
}
finally {
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
}

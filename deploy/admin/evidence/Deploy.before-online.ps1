[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipInstall,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$')]
    [string]$ReleaseId
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshTarget = 'root@51.83.101.143'
$remoteRoot = '/opt/rosekhlifa-blog'
$previousLocation = Get-Location
function Assert-NativeSuccess([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit status $LASTEXITCODE" }
}
try {
    Set-Location -LiteralPath $projectRoot
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot 'Build.ps1') -SkipInstall:$SkipInstall
    } else {
        & node deploy/verify-build.mjs
        Assert-NativeSuccess 'Existing build verification'
    }
    if (-not $ReleaseId) {
        $revision = (& git rev-parse --short=12 HEAD).Trim()
        Assert-NativeSuccess 'Source revision'
        $ReleaseId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + $revision
    }
    $artifactRoot = Join-Path $PSScriptRoot 'artifacts'
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
    $archive = Join-Path $artifactRoot "$ReleaseId.tar.gz"
    & tar.exe -czf $archive -C dist .
    Assert-NativeSuccess 'Static archive packaging'
    $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    # This marker protects unrelated existing directories from accidental reuse.
    $bootstrap = "set -eu; if [ -e '$remoteRoot' ] && [ ! -f '$remoteRoot/.managed-by-rosekhlifa-blog' ]; then echo 'Existing directory is not managed by this deployment' >&2; exit 1; fi; mkdir -p '$remoteRoot/deploy' '$remoteRoot/incoming'; touch '$remoteRoot/.managed-by-rosekhlifa-blog'"
    & ssh -o BatchMode=yes -o ConnectTimeout=15 $sshTarget $bootstrap
    Assert-NativeSuccess 'Remote deployment directory'
    & scp -o BatchMode=yes -o ConnectTimeout=15 deploy/compose.yaml deploy/nginx.conf deploy/activate.sh deploy/ROLLBACK.sh "${sshTarget}:$remoteRoot/deploy/"
    Assert-NativeSuccess 'Service files upload'
    & scp -o BatchMode=yes -o ConnectTimeout=15 deploy/runtime.env "${sshTarget}:$remoteRoot/.env"
    Assert-NativeSuccess 'Pinned runtime configuration upload'
    & scp -o BatchMode=yes -o ConnectTimeout=15 $archive "${sshTarget}:$remoteRoot/incoming/$ReleaseId.tar.gz"
    Assert-NativeSuccess 'Release upload'
    & ssh -o BatchMode=yes -o ConnectTimeout=15 $sshTarget "chmod 0755 '$remoteRoot/deploy/activate.sh' '$remoteRoot/deploy/ROLLBACK.sh'; bash '$remoteRoot/deploy/activate.sh' '$ReleaseId' '$archiveHash'"
    Assert-NativeSuccess 'Release activation'
    & node deploy/verify-public.mjs http://51.83.101.143:18180
    Assert-NativeSuccess 'Public deployment verification'
    $receipt = [ordered]@{
        releaseId = $ReleaseId
        sourceRevision = (& git rev-parse HEAD).Trim()
        siteUrl = 'https://blog.rosekhlifa.com'
        publicUrl = 'http://51.83.101.143:18180'
        sshTarget = $sshTarget
        serverRoot = $remoteRoot
        archive = $archive
        archiveSha256 = $archiveHash
        completedUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactRoot 'last-deployment.json') -Encoding utf8
    Write-Output "DEPLOY PASS: $ReleaseId http://51.83.101.143:18180"
} finally {
    Set-Location -LiteralPath $previousLocation
}

[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sshTarget = 'root@51.83.101.143'
$remoteRoot = '/opt/rosekhlifa-blog'
$previousLocation = Get-Location
function Assert-NativeSuccess([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit status $LASTEXITCODE" }
}
try {
    Set-Location -LiteralPath $projectRoot
    $revision = (& git rev-parse --short=12 HEAD).Trim()
    Assert-NativeSuccess 'Read upstream revision'
    $artifactRoot = Join-Path $projectRoot 'deploy/artifacts'
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
    $archiveName = "online-source-$revision.tar.gz"
    $archivePath = Join-Path $artifactRoot $archiveName
    & git archive --format=tar.gz --output=$archivePath HEAD
    Assert-NativeSuccess 'Archive theme source'
    $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    & ssh -o BatchMode=yes -o ConnectTimeout=15 $sshTarget "mkdir -p '$remoteRoot/deploy/admin' '$remoteRoot/incoming'"
    Assert-NativeSuccess 'Prepare online administration directories'
    $files = @('compose.yaml', 'nginx.conf', 'status.js', 'publisher.py', 'publisher.service', 'activate-online.sh', 'editor.service', 'astro-online.config.mjs', 'session-auth.py', 'session-auth.service', 'install.sh', 'ROLLBACK.sh') | ForEach-Object { Join-Path $PSScriptRoot $_ }
    & scp -o BatchMode=yes -o ConnectTimeout=15 @files "${sshTarget}:$remoteRoot/deploy/admin/"
    Assert-NativeSuccess 'Upload online administration services'
    & scp -o BatchMode=yes -o ConnectTimeout=15 (Join-Path $PSScriptRoot 'domain/install-session-auth.sh') "${sshTarget}:$remoteRoot/deploy/admin/install-session-auth.sh"
    Assert-NativeSuccess 'Upload session login installer'
    & scp -o BatchMode=yes -o ConnectTimeout=15 $archivePath "${sshTarget}:$remoteRoot/incoming/$archiveName"
    Assert-NativeSuccess 'Upload initial source snapshot'
    & ssh -o BatchMode=yes -o ConnectTimeout=15 $sshTarget "bash '$remoteRoot/deploy/admin/install.sh' '$archiveName' '$archiveHash'"
    Assert-NativeSuccess 'Install online writing services'
    & scp -o BatchMode=yes -o ConnectTimeout=15 "${sshTarget}:$remoteRoot/admin-secrets/login.txt" (Join-Path $artifactRoot 'online-admin-login.txt')
    Assert-NativeSuccess 'Download generated login details'
    & scp -o BatchMode=yes -o ConnectTimeout=15 "${sshTarget}:$remoteRoot/admin-secrets/server.crt" (Join-Path $artifactRoot 'online-admin-server.crt')
    Assert-NativeSuccess 'Download editor certificate'
    $credentialPath = Join-Path $artifactRoot 'online-admin-login.txt'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $credentialPath /inheritance:r /grant:r ($identity + ':(F)') | Out-Null
    Assert-NativeSuccess 'Protect local login details'
    Write-Output 'ONLINE ADMIN PASS: installed; credentials in deploy/artifacts/online-admin-login.txt'
} finally {
    Set-Location -LiteralPath $previousLocation
}

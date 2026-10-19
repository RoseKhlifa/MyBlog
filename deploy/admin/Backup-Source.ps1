[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$archiveName = 'server-source-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.tar.gz'
$remoteArchive = '/opt/rosekhlifa-blog/source-backups/' + $archiveName
$artifactRoot = Join-Path $projectRoot 'deploy/artifacts'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
& ssh -o BatchMode=yes -o ConnectTimeout=15 root@51.83.101.143 "tar -czf '$remoteArchive' --exclude=./node_modules --exclude=./.astro --exclude=./dist --exclude=./.git --exclude=./.trash -C /opt/rosekhlifa-blog/source ."
if ($LASTEXITCODE -ne 0) { throw 'Server source backup failed.' }
$destination = Join-Path $artifactRoot $archiveName
& scp -o BatchMode=yes -o ConnectTimeout=15 "root@51.83.101.143:$remoteArchive" $destination
if ($LASTEXITCODE -ne 0) { throw 'Backup download failed.' }
Write-Output "BACKUP PASS: $destination"

[CmdletBinding()]
param([switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousLocation = Get-Location
$oldSiteUrl = $env:SITE_URL
$oldBasePath = $env:ASTRO_WHONO_BASE_PATH
try {
    Set-Location -LiteralPath $projectRoot
    $requiredNode = (Get-Content -LiteralPath (Join-Path $projectRoot '.nvmrc') -Raw).Trim()
    $actualNode = (& node --version).Trim()
    $npmCommand = 'npm.cmd'
    $npmPrefix = @()
    if ($actualNode -ne "v$requiredNode") {
        if (-not (Get-Command volta -ErrorAction SilentlyContinue)) {
            throw "Use Node $requiredNode from .nvmrc, or install Volta so this script can select it automatically. Current runtime: $actualNode"
        }
        $npmCommand = 'volta'
        $npmPrefix = @('run', '--node', $requiredNode, 'npm')
    }
    function Invoke-ProjectNpm([string[]]$Arguments) {
        & $npmCommand @npmPrefix @Arguments
        if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed: $LASTEXITCODE" }
    }
    Write-Output "Build runtime: Node $requiredNode (.nvmrc)"
    $settings = ConvertFrom-StringData (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'site.env') -Raw)
    if ($settings.SITE_URL -ne 'https://blog.rosekhlifa.com' -or $settings.ASTRO_WHONO_BASE_PATH -ne '/') {
        throw 'Expected SITE_URL=https://blog.rosekhlifa.com and ASTRO_WHONO_BASE_PATH=/'
    }
    $env:SITE_URL = $settings.SITE_URL
    $env:ASTRO_WHONO_BASE_PATH = $settings.ASTRO_WHONO_BASE_PATH
    if (-not $SkipInstall) {
        Invoke-ProjectNpm -Arguments @('ci', '--no-fund', '--no-audit')
    }
    Invoke-ProjectNpm -Arguments @('run', 'verify')
    Invoke-ProjectNpm -Arguments @('run', 'check:prod-artifacts')
    & node deploy/verify-build.mjs
    if ($LASTEXITCODE -ne 0) { throw "Deployment build verification failed: $LASTEXITCODE" }
} finally {
    $env:SITE_URL = $oldSiteUrl
    $env:ASTRO_WHONO_BASE_PATH = $oldBasePath
    Set-Location -LiteralPath $previousLocation
}

# Sign a binary using Azure Trusted Signing via trusted-signing-cli
#
# Prerequisites:
# - trusted-signing-cli installed: cargo install trusted-signing-cli
# - Environment variables: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET
#   (load from .env with: . .\load-signing-env.ps1)
#
# Usage:
#   .\sign-binary.ps1 -FilePath "path\to\file.exe"

param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

$ErrorActionPreference = "Stop"

# Resolve to absolute path
$FilePath = Resolve-Path $FilePath -ErrorAction Stop

Write-Host "Signing: $FilePath" -ForegroundColor Cyan

# Check environment variables
$requiredEnvVars = @("AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET")
foreach ($var in $requiredEnvVars) {
    if (-not (Test-Path "env:$var")) {
        Write-Error "Environment variable $var is not set. Run: . .\windows_signing\load-signing-env.ps1"
        exit 1
    }
}

# Check trusted-signing-cli is installed
$tsc = Get-Command trusted-signing-cli -ErrorAction SilentlyContinue
if (-not $tsc) {
    Write-Error "trusted-signing-cli not found. Install with: cargo install trusted-signing-cli"
    exit 1
}

# Sign
trusted-signing-cli -e https://eus.codesigning.azure.net -a kylegraehl -c jstorrent-profile $FilePath

if ($LASTEXITCODE -ne 0) {
    Write-Error "Signing failed with exit code: $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Successfully signed: $FilePath" -ForegroundColor Green

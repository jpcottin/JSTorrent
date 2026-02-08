# Windows Code Signing

Signs Windows binaries and installers with Azure Trusted Signing using `trusted-signing-cli`.

## Prerequisites

1. **Rust toolchain** (for installing the CLI)
2. **Azure credentials** (3 environment variables)

No DLLs, no signtool.exe, no .NET runtime, no Windows SDK required.

## One-Time Setup

### 1. Install trusted-signing-cli

```powershell
cargo install trusted-signing-cli
```

### 2. Set up credentials

Copy `.env.example` to `.env` and fill in `AZURE_CLIENT_SECRET`:

```powershell
cp .env.example .env
# Edit .env and add your secret VALUE (not the secret ID!)
```

The `.env` file contains:
- `AZURE_CLIENT_ID` - App Registration client ID
- `AZURE_TENANT_ID` - Azure AD tenant ID
- `AZURE_CLIENT_SECRET` - Client secret VALUE (expires 12/19/2027)

If you don't have the secret value, create a new one:
Azure Portal -> App Registration -> Certificates & secrets -> New client secret.
Copy the VALUE immediately (shown only once).

## Usage

### Load credentials and build with signing

```powershell
# From desktop/ directory
. .\windows_signing\load-signing-env.ps1

$env:SIGN_BINARIES = "1"
.\scripts\build-windows-installer.ps1
```

This will:
1. Build all Rust binaries
2. Sign each binary (jstorrent-host, jstorrent-io-daemon, jstorrent-link-handler)
3. Create the Inno Setup installer
4. Sign the installer

### Sign a single binary

```powershell
. .\windows_signing\load-signing-env.ps1
.\windows_signing\sign-binary.ps1 -FilePath "target\release\jstorrent-host.exe"
```

### Build without signing

```powershell
.\scripts\build-windows-installer.ps1
```

## CI

Signing is enabled in `.github/workflows/system-bridge-ci.yml` when `AZURE_CLIENT_SECRET` is configured as a GitHub secret. CI uses the same `trusted-signing-cli` tool and Azure endpoint.

Required GitHub secrets:
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_SECRET`

## Azure Configuration

- **Endpoint**: `https://eus.codesigning.azure.net` (East US)
- **Account**: `kylegraehl`
- **Certificate profile**: `jstorrent-profile`
- **Required role**: App Registration needs "Trusted Signing Certificate Profile Signer" on the Trusted Signing Account

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 403 Forbidden | Check env vars are set; verify secret VALUE not ID; check IAM role |
| "Invalid client secret" | You're using the secret ID instead of the VALUE |
| Endpoint error | Verify endpoint matches Azure Portal -> Trusted Signing Account -> Account URI |
| `trusted-signing-cli` not found | Run `cargo install trusted-signing-cli` |

## Files

| File | Purpose |
|------|---------|
| `sign-binary.ps1` | Sign a single binary |
| `load-signing-env.ps1` | Load Azure credentials from `.env` |
| `.env.example` | Template for credentials |
| `.env` | Your credentials (gitignored) |
| `signing/` | Deprecated (old signtool.exe + DLL approach) |

# iOS AltStore PAL Distribution Guide

## Overview

JSTorrent iOS is distributed via [AltStore PAL](https://altstore.io/) (EU only) under the EU Digital Markets Act. Apple notarizes the app (lighter review than App Store) and generates an Alternative Distribution Package (ADP) that AltStore serves to users.

## Account Setup (completed 2026-03-14)

### Prerequisites

- **Apple Developer Program** membership (paid)
- **Alternative Terms Addendum for Apps in the EU** — agreed to in Apple Developer account
- **AltStore PAL developer registration** — via their REST API

### What's configured

| Item | Value | Date |
|------|-------|------|
| AltStore PAL marketplace added in ASC | Yes | 2026-03-14 |
| JSTorrent selected for marketplace distribution | Yes | 2026-03-14 |
| Notifications enabled | Yes | 2026-03-14 |
| EU Alternative Terms Addendum | Agreed | 2026-03-14 |
| Apple Developer ID (UUID) | `69a6de73-cdf5-47e3-e053-5b8c7c11a4d1` | — |
| Apple Developer Team ID | `VD7BYQ6ABM` | — |
| Bundle ID | `com.jstorrent.ios` | — |

### AltStore PAL token

The PAL token is a short-lived JWT (~24 hours) obtained from the AltStore REST API. It's stored at `~/Documents/apple_keys/pal_token.json`.

**Refresh the token:**

```bash
curl -s -X POST https://api.altstore.io/register \
  -H "Content-Type: application/json" \
  -d '{"developerID":"69a6de73-cdf5-47e3-e053-5b8c7c11a4d1","email":"kgraehl@gmail.com"}'
```

Save the response to `~/Documents/apple_keys/pal_token.json`. The token expires in ~24 hours — you only need to refresh it when actively doing a release.

The token was also used once to add AltStore PAL as a marketplace in App Store Connect (Users and Access → Integrations → Marketplace). That marketplace registration persists — you don't need to re-add it.

## Release Flow

### Step 1: Tag and build (automated)

```bash
./scripts/release-ios.sh <version>
```

This pushes an `ios-v{version}` tag. CI (`ios-ci.yml`) builds the IPA, uploads to App Store Connect, and creates a draft GitHub Release.

### Step 2: CI submits for notarization, fetches ADP, and publishes (automated)

CI automatically:
1. Creates an app store version with review type `NOTARIZATION` via the ASC API
2. Submits for notarization (not App Store review)
3. Polls until notarization completes and ADP is generated
4. Downloads the ADP and uploads it to the GitHub Release
5. Generates `website/public/altstore-source.json` and commits to main
6. Undrafts the GitHub Release

Notarization uses the [Notarization Review Guidelines](https://developer.apple.com/documentation/appdistribution) — a subset focused on security and privacy, not content policy. It typically completes in minutes, not days.

No manual steps required after pushing the tag.

### Step 3: Verify

- Check that `https://jstorrent.com/altstore-source.json` is updated
- Users add JSTorrent via: `altstore://source?url=https://jstorrent.com/altstore-source.json`

### Fallback: manual finalize

If the main CI job times out (e.g., notarization takes longer than expected), use the **"iOS Finalize Release"** workflow from GitHub Actions:

1. Go to GitHub → Actions → "iOS Finalize Release"
2. Click "Run workflow"
3. Enter the version number (e.g., `1.0.1`)

This re-runs the ADP fetch and finalization steps.

## Mistakes to Avoid

### Do NOT manually "Submit for Review" in ASC

CI handles submission via the API with `reviewType: NOTARIZATION`. If you manually click "Submit for Review" in the ASC UI, it triggers a full App Store review, which will reject torrent clients under guideline 5.2.3 (Audio/Video Downloading). This happened with v1.0 on 2026-03-20. The rejection can be ignored — just create a new version.

### Token expiration

The AltStore PAL token expires in ~24 hours. If you get auth errors from the AltStore API, refresh it (see above). The token is only needed for:
- Initial marketplace setup in ASC (already done, one-time)
- ADP processing via AltStore API (if using their API instead of ASC API directly)

## App Store Connect API Secrets

These are stored as GitHub repository secrets for CI:

| Secret | Purpose |
|--------|---------|
| `ASC_API_KEY_P8_BASE64` | App Store Connect API key (.p8, base64) |
| `ASC_API_KEY_ID` | API Key ID |
| `ASC_API_ISSUER_ID` | API Issuer ID |
| `IOS_CERTIFICATE_P12_BASE64` | iOS distribution certificate |
| `IOS_CERTIFICATE_PASSWORD` | Certificate password |
| `IOS_PROVISIONING_PROFILE_BASE64` | Provisioning profile |
| `MACOS_KEYCHAIN_PASSWORD` | CI keychain password |

The .p8 key file is also stored locally at `~/Documents/apple_keys/` alongside the distribution certificate and provisioning profile.

## AltStore REST API Reference

Base URL: `https://api.altstore.io`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register developer, get token |
| `/adps` | POST | Submit ADP ID for processing |
| `/adps/{adpId}` | GET | Check ADP status / get download URL |
| `/federate` | POST | Make source discoverable on explore.alt.store |

Full docs: https://faq.altstore.io/developers/rest-api

## App Store Connect API Endpoints (for ADP)

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/apps?filter[bundleId]=com.jstorrent.ios` | Find app |
| `GET /v1/builds?filter[app]={id}&sort=-uploadedDate` | Find latest build |
| `GET /v1/builds/{id}/alternativeDistributionPackage` | Get ADP after notarization |
| `GET /v1/alternativeDistributionPackages/{id}/versions` | Get ADP versions |
| `GET /v1/alternativeDistributionPackageVersions/{id}/variants` | Get download URLs |

Automated by `ios/scripts/fetch-adp.py`.

## Files

| File | Purpose |
|------|---------|
| `ios/scripts/fetch-adp.py` | Fetches ADP from ASC API |
| `ios/altstore-source.template.json` | Template for AltStore source JSON |
| `scripts/ios-finalize-release.sh` | Generates source JSON from template |
| `website/public/altstore-source.json` | Published source (generated, committed) |
| `.github/workflows/ios-ci.yml` | Build + upload to ASC + draft release |
| `.github/workflows/ios-finalize-release.yml` | Post-notarization: fetch ADP, finalize release |
| `~/Documents/apple_keys/pal_token.json` | AltStore PAL token (local, short-lived) |

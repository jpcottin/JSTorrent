# AltStore PAL Distribution (iOS)

JSTorrent iOS is distributed via AltStore PAL (EU only) because Apple rejects torrent clients from the App Store under guideline 5.2.3 (Audio/Video Downloading).

## Key Distinction: Notarization vs App Store Review

- **NOTARIZATION** (`reviewType: NOTARIZATION`): Automated process, no content policy review. Required for alternative marketplace distribution under EU DMA.
- **App Store Review** (`reviewType: APP_STORE`): Human review that applies all App Review Guidelines including 5.2.3. Will be rejected.

**Do NOT click "Submit for Review" in the App Store Connect UI.** That triggers App Store review. Notarization is done via the ASC API (automated in CI).

## Prerequisites

1. Apple Developer account with **EU Alternative Distribution Marketplace addendum** signed (in Agreements, Tax, and Banking)
2. App Store Connect API key with **Admin** role (.p8 format)
3. Registered with AltStore PAL via their REST API
4. App configured for alternative distribution in App Store Connect (Distribution → Alternative Distribution)

## AltStore PAL Registration

Token must be refreshed for each release (~24 hour expiry).

```bash
curl -X POST https://api.altstore.io/register \
  -H "Content-Type: application/json" \
  -d '{"developerID":"<Apple Developer ID UUID>","email":"<email>"}'
```

- **Developer ID**: UUID from developer.apple.com/account → Membership → Developer ID
  - NOT the Team ID (which is a 10-char alphanumeric like VD7BYQ6ABM)
  - Our Developer ID: `69a6de73-cdf5-47e3-e053-5b8c7c11a4d1`
- **Email**: `kgraehl@gmail.com`
- Token saved at: `~/Documents/apple_keys/pal_token.json`

## ASC API Key

Created at App Store Connect → Users and Access → Integrations → App Store Connect API.

| Field | Value |
|-------|-------|
| Key ID | `N36U7F9F8T` |
| Issuer ID | `69a6de73-cdf5-47e3-e053-5b8c7c11a4d1` |
| Role | **Admin** (required for creating versions and submitting) |
| Key file | `~/Documents/apple_keys/appstore-connect-admin-AuthKey_N36U7F9F8T.p8` |

GitHub secrets (used by CI):
- `ASC_API_KEY_P8_BASE64` — base64-encoded .p8 key
- `ASC_API_KEY_ID` — key ID
- `ASC_API_ISSUER_ID` — issuer ID

**Note:** A Developer-role key can upload builds but cannot create versions or submit for review (403 FORBIDDEN).

## CI Flow (Automated)

1. CI builds and uploads IPA to ASC via `xcrun altool --upload-app`
2. `ios/scripts/fetch-adp.py` handles the rest:
   - Finds app and latest build
   - Creates (or reuses) an appStoreVersion with `reviewType: NOTARIZATION`
   - Attaches the build
   - Submits for notarization via reviewSubmissions API
   - Cancels any conflicting old submissions automatically
   - Polls until ADP (Alternative Distribution Package) is generated (~2-5 min)
   - Downloads ADP variants
3. ADP is attached to the GitHub release
4. `scripts/ios-finalize-release.sh` updates `website/public/altstore-source.json`

## Manual Recovery

If something goes wrong (e.g., accidentally submitted for App Store review):

```bash
# Run fetch-adp.py locally — it handles cancelling old submissions
python3 ios/scripts/fetch-adp.py \
  --key-path ~/Documents/apple_keys/appstore-connect-admin-AuthKey_N36U7F9F8T.p8 \
  --key-id N36U7F9F8T \
  --issuer-id 69a6de73-cdf5-47e3-e053-5b8c7c11a4d1 \
  --bundle-id com.jstorrent.ios \
  --version <VERSION> \
  --output-dir ./adp
```

The script will:
- Detect if the version is stuck in another submission
- Cancel conflicting submissions (UNRESOLVED_ISSUES, WAITING_FOR_REVIEW, etc.)
- Wait for cancellation to complete
- Create a new submission with `reviewType: NOTARIZATION`

## Common Issues

| Error | Cause | Fix |
|-------|-------|-----|
| Guideline 5.2.3 rejection | Submitted for App Store review instead of notarization | Cancel submission, resubmit with `reviewType: NOTARIZATION` via API |
| 409 "cannot create version in current state" | Old rejected/in-review version blocking | Cancel old review submission first |
| 409 "ITEM_PART_OF_ANOTHER_SUBMISSION" | Version claimed by previous submission | `fetch-adp.py` handles this automatically |
| 403 "API key does not allow" | Key doesn't have Admin role | Create new key with Admin role in ASC |
| AltStore token expired | Tokens last ~24 hours | Re-register at `api.altstore.io/register` |
| 404 "alternativeDistributionPackage does not exist" | ADP not generated yet | Wait — notarization takes 2-5 minutes |

## History

- **2026-03-14**: First submission — accidentally clicked "Submit for Review" in ASC UI, got rejected under guideline 5.2.3
- **2026-03-23**: Figured out the correct notarization flow via ASC API, automated in CI

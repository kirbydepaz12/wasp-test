# WASP v16.0.1 — Mobile Bridge Setup & Security (STAGING)

**This release is intended for the separate v16 staging repository only.** Do not overwrite the live v15 Cloudflare Worker or Docker database. Existing v16.0.0 staging installations can upgrade in place **without dropping their D1 database, R2 bucket or Docker volumes**.

## What changed

- Admin → **Network** now contains three subtabs in order: **Connected peers / Mobile Bridge / Crons**. The old Mobile Bridge card is removed from General settings.
- Admin → Network → **Mobile Bridge** shows distinct operational states: enabled/disabled and encryption configured/missing. It shows the current mobile server address.
- A new **Generate secure secret** button creates a random 256-bit server key and saves it under the staging D1 `settings` table. No Cloudflare runtime `MOBILE_BRIDGE_SECRET` is required for a **new installation**.
- **Use existing secret** accepts a securely generated 64–128-character hexadecimal string. Do not use hashes of dictionary words, ordinary passwords or a shell command as the secret value.
- **Move existing secret into WASP** safely migrates a pre-existing v16.0.0 runtime secret into managed storage without changing the effective encryption key or revoking device credentials. Do this **before** removing a legacy Cloudflare Worker secret, if you already issued keys.
- **Reset server secret** requires the exact word `RESET`; it generates a new random secret and atomically deletes all existing mobile app keys/scrobble deduplication receipts. **All mobile clients must generate new app keys afterward.** Music, playlists, users and their listening history are not deleted.
- Account Settings → Mobile clearly indicates setup is required; its Create Key button is disabled and visually muted. The backend rejects key generation as well when no secret is configured.
- Native WASP webapp, original WASP API, v15 peers, music storage and public Request are unchanged.

## Deployment: Cloudflare staging

1. Make a D1 database backup. Check that your `wasp-test` Worker is bound to **staging-only** D1 (`DB`) and R2 (`MUSIC`).
2. Update **only** the staging Git repository with v16.0.1, then redeploy its Worker. Keep your production v15 Worker unchanged. Do not create a new D1 or overwrite existing storage.
3. Sign in as the staging administrator. Go to **Admin → Network → Mobile Bridge** (deep link: `/admin.html#network/mobile`).
4. If status says **Setup required**, click **Generate secure secret**. Wait for **Encryption configured**. You can leave Mobile Bridge disabled until then. No Cloudflare runtime secret setup or GitHub build variable is necessary.
5. Check **Enable Mobile Bridge on this server**, then **Save Mobile Bridge settings**. Confirm the status reads enabled and ready.
6. Sign in with a regular staging member account; Account Settings → Mobile → **Generate mobile app key**. A unique app secret appears only once. Use that in the Subsonic app with `https://YOUR-STAGING-HOST/mobile` (or the root host for clients that disregard paths). Never use the website login password in a mobile app.
7. Verify `https://YOUR-STAGING-HOST/mobile/rest/getOpenSubsonicExtensions.view?f=json`, then test authenticated `ping.view`, streaming and seek/range. Monitor Worker logs but don't expose URL query tokens.

If Cloudflare reports a legacy runtime secret, click **Move existing secret into WASP** while the old environment secret is still available. Once the UI indicates the source is WASP-managed, you may remove the now-unneeded legacy runtime variable using Cloudflare Settings → Variables and Secrets. **Do not remove an existing secret before migration** if you want to retain compatibility with previously generated device keys.

## Deployment: Docker / Portainer staging

Existing Docker installations auto-generate a persistent `SCANNER_SECRET` for unrelated scanner functions. Mobile Bridge can reuse it for backwards compatibility or migrate it to WASP-managed D1 with the admin button. You do not need to change Docker credentials or volumes to get Mobile Bridge running. Retain the app state volume during redeploy and back it up. This update does **not** remove Docker's `SCANNER_SECRET`, which is still used by the folder scanner.

## Security model and limitations

**Trade-off:** WASP-managed setup is more convenient, but storing the server encryption key and legacy encrypted app-password material inside the **same database** weakens separation against a database-read compromise. D1 encrypts at rest but does not provide the same isolation as a Cloudflare runtime secret. Restrict D1 and admin access, retain backups, enable MFA on host accounts, and keep staging separate from production. Never expose the settings row through a public API, logs or screenshots.

The server secret protects the **encrypted legacy Subsonic app-password representation**. Each device also has a one-way SHA-256 key lookup hash; mobile credentials are shown once and revocable. API credentials can be placed into HTTP query strings by some clients, so use HTTPS, don't log them, and don't send them to untrusted peers. Native WASP passwords and session cookies remain separate. The older Cloudflare runtime secret is supported **only as a compatibility/migration fallback**; new installations do not depend on it.

Resetting the server secret immediately invalidates all Mobile Bridge device keys. The secret value is never returned in admin status responses or the member settings API. An administrator must be authenticated to generate/import/migrate/reset the secret; member accounts cannot access these actions.

## Rollback

The new secret is stored as one additional D1 `settings` row: `mobile_bridge_secret_v1`. No existing music tables or files are modified. Rolling back code to v16.0.0 does **not** make that older version understand the database-managed secret; mobile credential generation could stop unless a suitable runtime secret is restored. Keep the v16.0.1 build available for rollback of unrelated frontend changes, or disable Mobile Bridge without reverting the rest of WASP. A backup of the staging D1 database is recommended before setup or reset.

## Testing

`node --test tests/*.test.mjs` validates the Mobile Bridge lifecycle and WASP backend regressions. `python tests/ui_v16_mobile_bridge.py` checks member settings. New tests additionally cover missing-secret rejection, setup, import, migration, reset/revocation and UI/navigation. Live mobile client compatibility is still an **on-device staging validation requirement**.

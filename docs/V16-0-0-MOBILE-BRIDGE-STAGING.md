# WASP v16.0.0 — Mobile Bridge (STAGING RELEASE)

**Audience:** Operators who want to test Subsonic/OpenSubsonic clients against WASP while leaving a working v15 production deployment untouched.

## What it is

Mobile Bridge is an optional translator built into WASP, not a replacement for the native player, WASP peer protocol, or music database. It accepts compatible Subsonic/OpenSubsonic requests and resolves them against the **staging server's** WASP catalogue, including metadata synchronized from an administrator-added v15 peer. For remote tracks, it streams bytes directly from the source v15 peer on demand. It does **not** import/copy the source's MP3 collection.

**Do not deploy this staging release over your current production worker, GitHub repository, Portainer stack or database.** Use a different repository and a separately named Worker/Portainer stack with isolated persistence. This is a locally tested preview: it has **not** been validated against actual mobile clients, a live Cloudflare deployment, or your particular v15 host.

## Isolation checklist — do this BEFORE first deploy

1. Create a new staging GitHub repository. Extract the **contents** of the release's `WASP-v16.0.0-staging/` folder to the root of that repository. Do not push this to the production `KNDPZ/WASP` main branch.
2. Confirm `wrangler.jsonc` uses Worker name `wasp-v16-staging` (or your own **unique staging Worker name**) and does **not** target the production Worker. Do not connect the new staging repo to production's Worker build.
3. Provision **staging-only D1 and R2 resources**, and verify their actual resource IDs/bucket names in the Cloudflare dashboard. The shipped Wrangler configuration intentionally has no production IDs. Do not bind production D1/R2 to this Worker; a separate URL alone does not provide storage isolation.
4. Add a persistent random secret using Cloudflare Worker secrets, **never in Git**: `npx wrangler secret put MOBILE_BRIDGE_SECRET`. Use 32+ unpredictable bytes, securely generated, retained in a password manager. Replacing/loss of this secret invalidates previously generated encrypted app passwords for legacy token authentication.
5. On first installation, change WASP's default administrator password **before exposing staging to the internet**, and create a normal test member account. The admin account itself is not a Subsonic member credential.
6. Keep the v15 source's own storage and webapp unchanged. The only expected interaction is *read-only peer catalogue syncing and on-demand public/shared audio requests* from staging. Ensure the source v15 server has **Share this library on the network** enabled and is reachable from the staging server. Only use music you have permission to host/share.

### Cloudflare Workers deployment

- Connect the separate staging repository to a **new** Cloudflare Worker. In build settings, the repository root is the project root.
- Set **Deploy command:** `npm run deploy` (runs `npm run build:docs && wrangler deploy`). Do not use production Worker identifiers or the production domain.
- Confirm your staged D1 (`DB`) and R2 (`MUSIC`) bindings are both present and isolated from v15. A Wrangler auto-provisioning dialog/resource-creation flow may appear, depending on the Cloudflare setup; review every name/ID before acceptance.
- Set `MOBILE_BRIDGE_SECRET` as a staging Worker secret.
- Use the unique `*.workers.dev` staging URL during testing, not `https://wasp.playy.online` and not a production alias.

### Docker / Portainer staging

- Use a separate Portainer stack and `docker-compose.yml` in this release. Default host ports are **18080 HTTP / 18443 HTTPS**, so the common production ports 80/443 are not replaced.
- Persistent Docker volumes are prefixed `wasp-v16-*`. Double-check you don't map production volumes or music folders into the staging container unintentionally.
- Use a strong persistent `SCANNER_SECRET` or set `MOBILE_BRIDGE_SECRET` in your deployment environment. Staging credentials use it to encrypt legacy app-secret material; changing it affects previously created credentials.
- Configure HTTPS for mobile login where possible; plain LAN HTTP is not secure for credentials or audio privacy. LAN URLs such as `https://192.168.1.10:18443/mobile` may need a trusted certificate or appropriate hostname.

## Connecting staging v16 to the existing v15 music server

1. On the **v15** source: allow network sharing under Admin → Network and confirm `https://YOUR-V15-HOST/api/peer` returns an `ok` response. Do not modify v15's D1/R2 or music files.
2. On the **v16 staging** admin interface: Admin → Network → Connected peers → add the **v15** server's normal public HTTPS URL. Do not add the stage server to itself.
3. Use the **Sync** action for the v15 peer. WASP's existing peer sync copies **metadata only** into staging's `peer_catalogue_chunks`; this is not a file transfer. You may optionally mark the peer as primary for ordinary WASP browsing, but it is **not required** by Mobile Bridge.
4. Check `https://YOUR-V16-STAGING/mobile` and sign into the staging website with a normal member account. Account Settings → **Mobile** is where members create per-device credentials; users from v15 are *not* automatically cloned to staging.
5. In staging Admin → General settings, enable **Mobile Bridge** (disabled by default), after checking that the encryption secret is configured. Then create a credential for each phone.
6. In a Subsonic/OpenSubsonic mobile app set the **Server URL** to `https://YOUR-V16-STAGING/mobile`, **username** to your *staging* WASP username, and **password** to the *generated mobile app secret* (not your normal website password). Apps that support API-key login can use the same generated secret as `apiKey` without a username.
7. Test `GET /mobile/rest/ping.view` with the app credentials, then browse artists, search, play one v15-sourced track, seek forward, and confirm the source MP3 remains untouched. A `/rest/*` alias is also provided for clients that strip subdirectory prefixes. **Apps differ in how they handle `/mobile`**, so try the alias root URL if a client cannot connect through the prefix.

**Example staging configuration:** `https://YOUR-V16-STAGING.workers.dev/mobile` (example only, not a live deployed URL). **The v15 music source is not the mobile login address.** The unique v16 staging hostname is.

## Supported behavior (v16 staging)

| Area | Status |
| --- | --- |
| `/mobile/rest/*.view`, `/rest/*.view`; GET and form POST; JSON and XML | Implemented |
| API key, per-device legacy app password, salted Subsonic token and hex password | Implemented; separate from main WASP password |
| Server probe, OpenSubsonic extension discovery, basic user info | Implemented |
| Artists, albums, songs, search, music-folder browse, album lists | Implemented against staging's local + synced v15 peer metadata |
| Album artwork | Local or source peer artwork fallback |
| Streams and downloads | Forward original audio bytes; peer Range requests forwarded; no transcoding |
| Existing WASP local and synced public peer playlists | Read-only in mobile app (edits not yet exposed) |
| Stars/favorites | Local staging songs only; peer hearts intentionally not modified |
| Scrobble / completed plays | Recorded only in **staging** database; source v15 not modified |
| Lyrics | Placeholder/empty response in this first staging release |
| Now Playing mobile heartbeat | Not yet integrated; a mobile app's buffer request is not proof of active listening |
| Genre-specific listings, transcode, audio conversion, playlist mutation | Not yet implemented |
| Offline downloads | Depends on the mobile app's own caching capability and the source's permitted access |
| Web player, public Request, Account Settings popup, v15 features | Retained from v15.0.9 starting point |

**Staging catalogue limits:** For bounded memory/DB reads, this first bridge limits the local catalogue to the most recent 6,500 songs, processes up to 15 configured synchronized peers, and reads at most 6,500 entries per peer. WASP peer syncing itself currently limits each track snapshot to 6,000 songs. Larger libraries require additional pagination work before production use.

## Security and privacy notes

- Mobile Bridge is **off by default**. Enable it only after provisioning a staging secret and verifying isolation.
- Each device gets a separate revocable credential. App secrets are shown **once**; D1 stores a hash and an encrypted copy only for legacy token verification. Never use a WASP website password as an app secret.
- API keys / Subsonic passwords are bearer credentials. Some mobile clients put them in query parameters, which can appear in proxy access logs; always use HTTPS and avoid logging request query strings.
- Source peer URLs are selected exclusively from admin-configured, synchronized peers. The bridge does not forward a mobile app's cookies or mobile credentials to v15. It will not follow arbitrary HTTP redirects from peers when proxying streams.
- The staging bridge cannot magically reach offline, private, or blocked peers. Do not configure untrusted peer targets or circumvent network policies.
- Source tracks and public playlists remain governed by v15 network sharing. Private v15 user accounts/playlists are not imported.
- D1 schema additions are non-destructive. Use staging backups anyway. No code rollback can recover accidentally shared/overwritten production storage.

## Validation checklist

- [ ] Original v15 site and player continue unchanged, with its original D1/R2 bindings.
- [ ] v16 has a separate GitHub repo, Worker, D1, R2, domain, secret, and (for Docker) volumes and ports.
- [ ] v16 admin version displays `16.0.0`.
- [ ] The v15 source responds to `/api/peer` and is added/synced from staging.
- [ ] v16's normal website still plays music and Account Settings popup works.
- [ ] Mobile Bridge is disabled by default; unavailable before activation.
- [ ] Authenticated mobile client can ping, browse, search, play, and seek a source v15 song.
- [ ] Revoking a credential immediately blocks further authenticated access.
- [ ] Range requests return partial content (`206`) with correct range/length where the source supports them.
- [ ] Private playlist data, website sessions, and admin credentials are not exposed through mobile APIs.
- [ ] v15 peer database, music files and playlists are unchanged after mobile playback.

### Rollback

Disable **Mobile Bridge** in staging Admin → General settings or stop the staging Worker/Portainer stack. The v15 production Worker, repository, domain, database, and music files are independent, so no v15 rollback should be necessary.

### Tests in this package

`npm run test:mobile` tests the protocol adapter. `node --test tests/*.test.mjs` runs the backend regression suite. These are **local automated tests**, not confirmation of support for any particular Subsonic mobile app. Test actual devices and your own Cloudflare/Docker staging configuration before considering any production release.

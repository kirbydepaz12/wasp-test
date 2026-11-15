# WASP v16.0.2 — Federated Subsonic Mobile Bridge (STAGING)

This release fixes v16.0.1's mobile catalogue limitation: local music and direct synchronized peers worked, but public music and playlists **behind** an existing WASP v15 gateway were not automatically included in compatible Subsonic/OpenSubsonic apps. This update remains **a staging candidate** until verified with your actual connected v15 sources and Android client.

## What changes

- **WASP stays native.** This is an adapter inside WASP. Original `/api/*`, web player, settings, peer protocol and uploads stay authoritative; no new Subsonic server or duplicate MP3 library is created.
- Mobile Bridge now reads local songs, direct synchronized v15 music and **one level of public HTTPS peers registered by that v15 gateway**.
- Peer media requests go to the real source's `/audio/<id>` with byte ranges and without cookies, mobile secrets or admin credentials. No audio files are copied. Redirects are rejected; if a duplicate is available from more than one peer, WASP can retry another trusted source.
- Public peer playlists and publicly shared member playlists from those downstream sources appear in `getPlaylists`. `track_sources` mappings resolve cross-peer playlist entries, including the borrowed remote tracks in public member playlists.
- `getArtists`, `getAlbumList2`, search, album and track metadata now see the federated catalogue. `getGenres` / `getSongsByGenre` work **when a source has real genre metadata** (from tags or public `/api/genres`). We do not fabricate genres for tracks with no classification.
- New keys are **16 mixed-case alphanumeric characters**, cryptographically generated using rejection sampling. Previously issued long keys stay valid and revocable. Only use app-specific keys, never WASP website passwords.
- The admin peer Sync button refreshes federation metadata when Mobile Bridge is enabled. Automatic peer-catalogue sync crons also refresh federation. The optional second-hop feature does not run when Mobile Bridge is disabled.
- Additional D1 tables `mobile_federation_sources` and `mobile_federation_chunks` store **metadata only**. They are created additively. No existing music or playlists are deleted or modified.

## Recommended upgrade procedure (your current setup)

1. **Back up your v16 staging D1 database and R2 state**. Keep the v15 production deployment untouched. Do not push staging code to the v15 production Git repository. Save the current v16.0.1 Git commit as your rollback point.
2. Extract the v16.0.2 upgrade patch into your existing **v16 staging repository** (`wasp-test`) and push. Do not overwrite or delete existing staging bindings.
3. Confirm Cloudflare deployed the new staging commit, and **Admin → version** reports `16.0.2`.
4. Under **Admin → Network → Mobile Bridge**, check that its status is configured/enabled. You can retain your current WASP-managed server secret and existing mobile device keys. **Do not reset the server secret.**
5. Under **Admin → Network → Connected Peers**, make sure `https://wasp.playy.online` (v15 gateway) is configured and its music is shared. Click **Sync** for this peer. Let `Tracks`, `Playlists`, `Users` and the final federation stage complete. The completion message now displays extra downstream peer/song/playlist counts and any source warnings.
6. If v15 has downstream peers, check that they use publicly reachable **HTTPS** URLs. A source accessible only via Tailscale, a private IP, a hostname blocked by the network, or HTTP-only URL will not be auto-discovered for Internet/mobile use. In that case, add an authorized public HTTPS source directly to v16 or expose it through an approved public endpoint. Do not weaken production-network controls.
7. In an Android Subsonic client, use `https://YOUR-STAGING-HOST/mobile` (or the base host if the client ignores subpaths), your v16 member username, and the WASP Mobile key. Refresh the client library; some apps cache music collections locally.
8. Confirm **Artists**, **Albums**, **Search**, **Playlists**, **Genres** (where metadata exists), playback of a remote-only track, seeking/Range (`206`) and completion scrobbling. Compare mobile search results against the music **actually available from the v15 network**, not only v16 local tracks.

## How discovery works and the trust boundary

Only the admin can register a v15 gateway in v16's Connected Peers. On authorized synchronization, the staging Worker asks the gateway's **existing public read-only** `/api/network/peers` and `/api/peer-catalogue` APIs for the downstream list and previously synchronized metadata. It also confirms that the gateway and each downstream source actively report an explicitly shared library via `/api/peer`. It excludes user-submitted community entries from automatic URL discovery and ignores private IPs, `localhost`, private-style domains, HTTP URLs, nonstandard ports, URL credentials and non-root paths. Only one downstream level is traversed (no uncontrolled recursion). If an approved source is missing from the cached gateway snapshot, the Worker probes that source's public `/api/peer` endpoint and reads its read-only `/api/tracks`, `/api/playlists`, `/api/user-playlists` and `/api/genres` APIs.

**Limits:** Up to 15 downstream sources per gateway; 6,000 tracks and 500 playlists of each kind per source; size-limited JSON and D1 metadata chunks. These are intentionally conservative staging limits. Larger networks require pagination or incremental synchronization rather than increasing limits recklessly. A source that becomes inaccessible can leave stale metadata visible until the next valid sync, but media playback cannot succeed while the source is unavailable. Peer URLs remain on the server; mobile API song identifiers do not expose the source URL. Only sources with a reachable audio endpoint can actually stream.

To keep the current system stable, a failure in federated discovery **does not roll back the direct peer snapshot** and does not affect the webapp's own catalogue. Warnings are reported in the admin Sync status.

## Backend tests and known limitations

Run `node --test tests/*.test.mjs` (includes the original v15 regressions and v16 federation tests). These tests use mock peers, sqlite fixtures and mock HTTP streams and do not touch your actual v15 accounts or music.

Known limitations:

- Some Subsonic clients implement optional endpoints differently. The actual Android app must be retested before promoting v16 to production.
- Genre browsing can still be empty if tracks and artists have no genre tags/metadata. WASP cannot infer a real genre reliably from a song title alone.
- Peer access requires a stable, public HTTPS endpoint. The v16 Worker does not bypass private networks or expose private bridge endpoints.
- Playlist **editing**, mobile live-playback heartbeat detection and transcoding are not implemented. Read-only playlist browsing, searching and original-audio streaming are the present scope.
- Some source playlists may reference audio from an origin no longer approved by the gateway or absent from its synchronized snapshot; those entries are intentionally omitted rather than streaming from an arbitrary URL.
- Cloudflare Worker network egress, origin latency and bandwidth can affect playback. No production performance promise is made from local tests.
- A v16.0.1 rollback does not understand the new federation tables (they can remain harmlessly in D1), but mobile federation disappears until this release is redeployed. Your existing short and long mobile credentials remain valid with the same managed secret.

## Production promotion gate

**Do not deploy directly into the live v15 Worker.** First verify your separate `wasp-test` Worker with actual v15-backed music. If successful, take a production backup, preserve the original `KNDPZ/WASP` release commit and deployment configuration, and prepare a controlled upgrade of the production code with separate feature enablement/rollback. Do not use `docker compose down -v` or destroy D1/R2 resources. This ZIP does not perform any deployment automatically.

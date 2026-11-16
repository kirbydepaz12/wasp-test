# WASP v17.0.0 — HIVE Telemetry & Loading Time Enhancement (staging release)

## Purpose

WASP v17 keeps the existing browser-based WASP player, P2P protocol, Cloudflare Worker, Docker stack, playlists, and optional Subsonic Mobile Bridge while introducing an **independently loaded HIVE Telemetry feature**. The chart is **website-only**; this release adds no Subsonic analytics UI or mobile-app requirements.

## Navigation and playback guarantees

- The music player and its `<audio>` element remain in `public/index.html` **outside** the `#list` content region. WASP never re-instantiates that element when navigating between `/#top`, `/#top/telemetry`, `/#hearts`, `/#likes`, `/#dislikes`, and other ordinary views.
- The first telemetry visit loads `public/telemetry.html`, `telemetry.css`, and `telemetry-view.js` through a same-origin iframe within the content area. Switching between the telemetry and reaction tabs preserves the already loaded iframe. Leaving the feature releases its chart resources. Neither case reloads the main document or audio source.
- The sidebar routes are unchanged. `/#top` shows the **Most listened / Telemetry** subtab bar. `/#top/telemetry` includes selectable **week/month/year/all-time** periods, years and months, previous/next period, and **Entire HIVE / This server** filters.
- Most listened, Most hearted, Most liked, and Most disliked use the lazy-loaded feature document and WASP's existing catalogued playback, votes, and peer library metadata. Clicking a song sends a same-origin, source-validated message to the parent to use the **same player**.
- **My Playlists stays a normal page and Account Settings stays a popup**, because bundling those functions into a new HTML file does not by itself improve load time. The account dialog and normal playlist views continue to load their data as needed.
- The admin **Insert sample slider** now inserts seven first-party **Featured Slides**, with slide 7 **ONE HIVE. EVERY BEAT.** after slide 6 **Shuffle the pit**. Existing customized slides are preserved. The first-party sample has no third-party ad/tracking requests. The new shuffle message type is `wasp:featured-shuffle`; old saved carousels using `ad:shuffle` remain supported.

## Confirmed-listen ledger and data correctness

The backend adds *only* these tables/indexes (through a resumable, additive migration):

- `telemetry_events`: source-owned unique event ID, origin server ID, UTC time, song title, artist, album, duration metadata; `UNIQUE(origin_id,event_id)` prevents repeat imports and sync loops.
- `telemetry_peer_cursors`: per-peer replication progress, node ID, last sync/error.
- `telemetry_summary_cache`: short-lived indexed historical summaries by period and scope.
- `settings` entries for instance identity, migration marker and bounded sync leases.

A confirmed WASP browser listening event is written to this ledger without disrupting the old Recently Listened flow. Successful *completed* Subsonic scrobbles also contribute; simple stream downloads or buffering are **not** treated as confirmed plays. For a v17-to-v17 proxied peer play, the relay signals the audio source to avoid adding a second ledger event. `recent_listens` is retained unchanged and provides **up to 1,000** previously retained entries as an initial, explicitly incomplete backfill. v15/v16 instances without the v17 ledger cannot supply their lost historical entries.

Statistics provided: confirmed plays and comparison totals, unique artists/albums/tracks, top artists/albums/tracks, monthly/daily charts, weekday and hourly charts, participating origin-server count, activity streaks, busiest day/hour, and anonymized aggregate listening-fingerprint indicators. The dashboard **does not invent** music-genre tags, artist countries, year-of-release charts, exact personal listening hours, complete old history, or user leaderboards when trustworthy data is absent. Source song duration is *not* proof of total listening time.

## Federated P2P telemetry

- On **every participating v17 server**, the `GET /api/telemetry/feed` API exposes confirmed anonymous music events **only while that server's existing library/network-sharing setting is enabled**. Event IDs are stable, real user IDs / usernames / tokens / session IDs / IPs are not transmitted, original precise timestamps are rounded to **five-minute buckets**, and source-server identities are preserved through relay hops.
- A receiving server reads the **existing admin peers plus approved and online user-published peers**, verifies their public `/api/peer` sharing response, imports a bounded incremental feed, and keeps a cursor per peer. At most 200 entries per peer request; up to 10 peers per sync cycle with rotating selection so no approved peer is permanently excluded when there are more than ten.
- Replication is **origin-aware**, not a sum of peer totals. The same event relayed via A→B→C and later C→A is deduplicated. Synced events do **not** carry mobile keys or personally identifiable account data. Private playlists and listening identities remain on their original server.
- Cloudflare runs this job from its existing Worker scheduled handler (normally every five minutes). Docker calls the same backend sync from its existing private cron poller, via `ctx.waitUntil`, so slow peer synchronization cannot delay the HTTP cron response. A database lease reduces duplicate refresh work. `POST /api/admin/telemetry/sync` provides an authenticated, explicit sync for an admin, if needed.
- Every server keeps its own local copy of the imported ledger and cached summaries. A disconnected peer does not stop music playback or make already-cached charts disappear; a "last synchronized" timestamp makes staleness visible.

### Privacy, trust and federation limitations

- **Network sharing must be explicitly enabled on each source server**. Telemetry is anonymous **aggregated public HIVE data**, not a server-wide transfer of personal listening history; private per-user history and opt-in user leaderboards are **not implemented** in this release.
- Trusted peers and submitted links must be deliberately configured/approved. Source node IDs are locally generated and not cryptographically signed in this version. A malicious or compromised peer can fabricate its own telemetry. Therefore cross-server totals are *best effort*, not audited listening proof. Future signed-peer identities, opt-in personal rankings, and robust origin revocation need separate security design.
- Confirmed-play events are written without sending full listening-session data between servers. Legacy v15/v16 peers continue to provide music and playlists but cannot yet participate in telemetry exchange; they are skipped without breaking peer connectivity.
- The public telemetry feed exposes title/artist/album listening trends to anyone who can access a shared server; operators should only enable network sharing for music they are comfortable making publicly visible. Do not reuse it for sensitive listening metadata.
- Historical coverage starts at v17 plus whatever limited, retained Recent Listen events survive migration. Long-term large-HIVE deployments need storage/daily-rollup monitoring and further retention policy work. Cloudflare Free D1 row and storage quotas may constrain sync volume; dashboard queries use 5-minute caches rather than re-aggregating per render. Remote peer time buckets can slightly affect edge-of-period counts.

## Deployment and rollback

1. **Staging first.** Apply the v17 upgrade patch **only to exactly v16.0.6**, or use the complete v17 staging package in an isolated repo. Take a verified D1/SQLite backup, preserve R2 and Docker volumes, keep the preceding Git commit, and avoid changing production Cloudflare Worker bindings.
2. Deploy the backend and static frontend together. Run `npm run build:docs` (or the usual `npm run deploy`) when building manually. Keep the existing Worker/staging name and Docker bindings and secrets so updates use the same persistent data. Never delete the state volumes and never run `docker compose down -v`.
3. Confirm the admin sidebar version reads `17.0.0`. Check `/#top/telemetry` through the **same WASP hostname** and switch `/#top`, `/#hearts`, `/#likes`, `/#dislikes` while real audio is playing. Check the audio element, track source, playhead and pause state are unchanged.
4. Add/verify a mutually connected pair of isolated v17 installations, including a Docker instance if possible, with `network_share` explicitly enabled. Listen to a known local song, relay a peer song, and verify exactly **one** event per actual confirmed listen across peers after synchronization. Test reconnection, multi-hop A→B→C→A and no extra counts after duplicate feeds.
5. Test period navigation and stale views: month/year/week, local versus HIVE, old year with no data, user-approved versus unapproved peers, offline and outdated peers. Ensure the app still serves music when telemetry storage/query fails.
6. To roll back, restore the previous code commit/build and deployment bindings. **The additive v17 telemetry tables will remain** and should not be manually deleted as a shortcut; full database restore requires a verified snapshot. Previous code does not depend on the new tables.

## Validation performed in development

- Node backend suite and WASP regressions, dedicated feed/caching/multi-peer deduplication tests.
- Headless Chromium checks that an actively playing audio track, original audio element and media source remain unchanged while switching Most listened, Telemetry, Hearts, Likes, Dislikes and Albums.
- Standalone telemetry UI smoke at desktop/mobile sizes: charts, filters, changing period/scope, responsive layout.
- Existing browser smoke tests for collapsed sidebar, Account Settings popup, Mobile Bridge credentials, and Currently Streaming.

**The above are local tests.** Real Cloudflare/Docker peer federation, production D1 usage, real-world media playback and multi-device responsiveness must be verified in staging before promoting the upgrade to a live installation. This release does **not** modify a running user server automatically.

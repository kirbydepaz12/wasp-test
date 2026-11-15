# WASP v15.0.7 — Recently listened timestamps and live playback

This is an additive update to the v15.0.6 sidebar-notification-fixed baseline.

## What changed

- `/#listened` shows relative play times (for example, `5 mins ago`) using the existing `played_at` history timestamp. The labels refresh while the view remains open.
- An animated icon based on the supplied streaming image appears beside a song when at least one WASP browser is actively playing that song. Paused/stopped tracks lose the icon after the next refresh.
- The status is refreshed every 10 seconds from this server and connected peers. Peers still on older releases will show history without live status until upgraded.
- The **Request** page remains available to logged-out visitors, entirely outside Account Settings. No account-settings modal was implemented in this update.

## Privacy and lifecycle

The client sends an anonymous in-memory random playback session ID, track ID, optional source peer URL, and playback state. The database stores only those fields and an expiration timestamp. No usernames, account IDs, IP addresses, or browsing details are stored in `active_streams`; the public GET endpoint returns *only* track/source pairs.

`playing` is sent on playback and refreshed about every 25 seconds. `stop` is sent on pause and can be sent on page close. Entries automatically stop appearing 65 seconds after the last heartbeat even if a tab crashes or loses connectivity. Live status is **not** inferred from audio HTTP requests, which can be buffers or prefetches.

## Deployment

For an existing v15.0.6 installation, apply the upgrade patch without deleting other files, rebuild/redeploy Worker assets or Docker, then reload the browser. The schema migration runs automatically and creates only a new `active_streams` table, an expiry index, and a migration marker. It does not modify tracks, play counts, requests, users, playlists, audio, or settings.

For an interconnected network, upgrading each participating WASP instance provides the most complete visibility of current playback. The status relies on participating WASP players, not generic external HTTP audio consumers.

## Files updated

`public/app.js`, `public/index.html`, `public/style.css`, `public/streaming.png` (provided image, whose uploaded bytes are a static PNG despite the `.gif` name), `src/index.js`, `docker/peer-relay.mjs`, `package.json`, regression tests, and this documentation.

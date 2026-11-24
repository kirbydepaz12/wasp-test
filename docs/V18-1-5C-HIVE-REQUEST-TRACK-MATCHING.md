# WASP v18.1.5c — HIVE Request Potential Matches & Individual Track Requests

**Upgrade baseline:** exact v18.1.5b source. This update changes the administrator Requests workflow and does not alter any MP3 audio, databases, playlists or users.

## New in Admin → Requests

- **Individual song requests:** Each locally originated active song request gets **Find potential match**, an inline search that searches both this server's local track catalogue and synchronized snapshots from connected/approved HIVE peers. The display identifies each result as Local or HIVE peer, includes its peer origin, and shows the matching score. A manual search can search title, artist or album. It never silently selects a lower-confidence candidate.
- **Approve or reject:** The admin explicitly approves one existing local or peer song to complete the individual request and move it to Previous requests. Rejecting a misleading candidate excludes that source and prevents the same request from being automatically completed by title matching; further manual selection is required. The API re-verifies the selected track in the approved catalogue at confirmation time.
- **Playlist missing tracks:** Every missing entry in a locally owned playlist request now includes **Request individual track**. This creates a standalone song request, even if the best suggested recording was rejected. Repeated clicks do not create duplicate active song requests. These playlist-derived song requests **require a verified administrator match**, even when a same-title recording already exists; a previously rejected wrong suggestion is carried forward. The playlist request remains intact and can still be reviewed/completed separately.
- **Rejected playlist candidates:** Excluded candidate IDs are now honored by automatic playlist matching and refresh. Rejected incorrect recordings are not silently restored as valid matches. No existing audio or playlist entry is removed when a candidate is rejected.

## Peer and catalogue visibility

The candidate search uses the same `spotifyImportCatalogue` source as Spotify/HIVE playlist recovery: actual local tracks plus trusted peer catalogue snapshots from connected administrator peers and permitted user-published peers. It does not run full peer network synchronization for every search, to avoid unnecessary Cloudflare CPU/D1 usage. For missing peer results, refresh/synchronize peer catalogues under Network, Metadata, Telemetry and retry. Offline peers or those without a synchronized snapshot may not appear, and remote music is not copied.

Remote HIVE-originated requests remain owned by their originating server. Manual match overrides are offered for **locally owned** requests only, so another server cannot silently close or rewrite the original request.

## Upgrade and safety

1. Back up your persistent Docker/Cloudflare data before updating. The incremental patch applies only to an exact v18.1.5b tree. If using the full ZIP, use it as the complete source and retain your original bindings, secrets, and persistent volumes.
2. Deploy to Test first, then inspect Admin → Requests. Open a song request and search for candidates from both Local and HIVE sources. Reject a deliberately incorrect candidate and verify it remains pending on Refresh. Accept a verified candidate and confirm it moves to Previous requests.
3. Open an active playlist request with missing songs, click **Request individual track** on one entry, and verify the new song request appears without deleting or changing the playlist.
4. Once staging is verified, deploy to Docker and Main. Never run `docker compose down -v` during an update.

No database migrations or environment variables are required. Playlists, track IDs, streaming, telemetry, metadata bank, R2 objects and Docker music volumes are unchanged. Tests are local automation only; no live Cloudflare or Docker deployment was performed.

**Version:** `v18.1.5c · HIVE Request Match & Individual Tracks`.

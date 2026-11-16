# WASP v17.0.1 — HIVE Telemetry Visual Refinement

## Summary

Incremental staging update **from exactly v17.0.0**. No changes to the browser's persistent `<audio>` player, P2P audio path, Mobile Bridge routes, account settings, credentials, user playlists, or existing player behavior.

- Listening clock: a 24-segment radial graphic with hour-level tooltips, strongest-hour summary, keyboard-focus labels, and the viewer's reported timezone offset.
- Listening history: exact date/bucket and confirmed-play count on hover/focus; the existing period-specific bucketing remains.
- Top tags: multi-genre, layered trend bands with labeled counts, hover/focus highlighting, and per-tag peak data when available. These are *tagged plays*, not a partition of total plays; a track can carry several genres.
- Music by decade: release-decade distribution with accurate count and percentage of all confirmed plays, artist/album/track counts, and top recorded album/artist for each decade.
- Artist map: lightweight, locally served world geometry and graduated country heat layer. Hover/focus reports counts and artist diversity. Countries are displayed only if verified ISO3 artist-origin metadata exists. No inference from listener IP or browser locale.
- All visual work remains confined to lazy-loaded `public/telemetry.html`, `telemetry-view.js`, and `telemetry.css`. All chart interactions are browser-native; nothing is sent to a third-party analytics or advertising service.

## Metadata collection and transparency

The existing v17 event ledger gains **additive** `genre`, `release_year`, and `country_code` fields. v17.0.1 also creates small local metadata tables for verified ID3 release years, genres, and artist-origin codes. Older event rows are preserved. Album/artist/track identities in the event ledger are not recalculated or overwritten.

- Existing artist Wikipedia/Wikidata genre tags (`artist_info.genres`) can support the genre chart immediately. Local track-level ID3 `TCON` genre tags can also contribute from new Cloudflare uploads, and Docker file scans provide ID3 genre values.
- Docker scanner reads `music-metadata` `common.year` and `common.genre` for new/indexed files. Browser MP3 uploads can supply `TYER`, `TDRC`, and `TCON` tags. Existing Docker files are re-read on scanner startup; already stored Cloudflare tracks that lack release-year tags in the database cannot be historically reconstructed without reliable metadata re-ingestion.
- The world visualization needs **verified origin country** codes. These fields can be carried between authorized v17.0.1 peers when known; the system intentionally does **not** invent a country from an artist's name, IP address, or genre. A server with no origin metadata shows the map with neutral countries and explains the missing coverage.
- Genre/decade/country groups use local SQL aggregates cached per period and scope. The telemetry feed remains origin-aware and deduplicated, strips source track IDs from peer-facing events, and never includes user IDs, mobile credentials or private session metadata.
- Before data is available for a period, charts say so instead of displaying fabricated statistics. The sample previews supplied with the release are explicitly illustrative.

## Deploy and roll back

1. Back up the staging D1 database (or Docker persistent state) and record the working v17.0.0 Git revision.
2. Apply the changes-only patch over exactly v17.0.0, or use the full source to build a separate staging deployment. Never use a changes-only patch on v15/v16.
3. Preserve `MUSIC`, `DB`, environment variables and Docker volumes. **Never run** `docker compose down -v`.
4. Confirm the Admin sidebar version reads **17.0.1**. Open `/#top/telemetry`, check the radial clock, date history tooltips, genre highlights, heatmap and decades. Empty metadata must produce honest empty states.
5. Play a track, navigate Telemetry / Hearts / Likes / Dislikes / Albums and back. Audio source, playback state and position must not be reset.
6. Sync two compatible peers and confirm that one event contributes once, with its existing source identity preserved. HTTP Range streaming and mobile sessions must still function.

This locally tested ZIP is a staging candidate, not a production migration guarantee. Real Android, Cloudflare, Docker, live peer connectivity and dataset-specific metadata must be verified before production rollout. The source packaging doesn't deploy to any live site.

World boundaries are based on Natural Earth public-domain low-resolution country geometry, bundled locally (no external map requests).

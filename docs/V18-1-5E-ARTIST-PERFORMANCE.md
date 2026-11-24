# WASP v18.1.5e — Artist Tab Performance Optimization

**Base version:** the exact WASP v18.1.5d full source. **Scope:** client-side artist list, navigation and artwork lookup performance. The existing Worker/Node API, D1 schema, R2 objects, MP3 files and Docker deployment settings are not changed.

## Changes

- **Build one artist index per loaded catalogue:** group local and deduplicated HIVE peer artist metadata once, including counts, last-added time, local/peer availability, and source-aware artwork origin. Reuse the index across Artist cards, the homepage artist carousel and single-artist pages. Previously, each rendered artist card could scan the full catalogue again to decide source badges and artwork origin.
- **Invalidate the cache on catalogue reload:** index reflects new local music, peer snapshots and selected deduplication routes after a successful catalogue refresh; it does not persist stale artist information across reloads.
- **Progressive artist cards:** show the first **48 cards** immediately; append another 48 as the visitor scrolls near the end. There is also a keyboard-accessible **Show more artists** button, including in browsers without IntersectionObserver. Artist search still searches the full index and Recently added → Artists retains track-based filtering.
- **Artwork fallback index:** when an artist/album cover fails, find eligible fallback tracks from the existing artist index rather than scanning every catalogue track for every failed image. Existing per-track embedded artwork and Docker peer relay fallbacks remain in place.
- **Playback continuity:** navigating the Artist grid does not recreate the persistent audio player or its queue.

## Performance scope and tradeoffs

This optimization reduces browser CPU, repeated scans and initial DOM/image work. It does **not** reduce the initial network cost of downloading local/remote track catalogues, eliminate artist artwork HTTP requests, or guarantee instant results when a connected peer or upstream image service is slow. Image loading remains lazy and source-aware. The homepage artist section and artist detail pages also use indexed lookups.

The included synthetic unit benchmark indexed 20,000 tracks and 1,700 artists in approximately 78 ms in the local Node environment. This is **not** a real production performance measurement. Real-world improvements depend on browser hardware, network, peer availability and artwork cache state.

## Verification and deployment

1. Deploy to the **Test WASP** installation first; use the full package or apply the patch only to the exact v18.1.5d source.
2. Open `/#artists` with many local/peer artists; verify cards appear in batches, source badges are accurate, and more artists load when scrolling or pressing Show more artists.
3. Search by artist name; open an artist and return. Check artwork fallback and audio playback continuity while browsing.
4. Confirm the admin sidebar reads `v18.1.5e · Artist Tab Performance`.
5. Validate music, playlist and HIVE peer behavior before upgrading Main or Docker. Preserve persistent storage, secrets, D1/R2 bindings and Docker volumes. Do **not** run `docker compose down -v`.

No new environment variables, database migrations or background tasks are introduced. Automated tests use fixtures and isolated Chromium runs; live AWS/Cloudflare deployment and live performance profiling have not been performed.

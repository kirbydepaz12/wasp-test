# WASP v18.2.0 — Artist Profiles, Discography & Refresh-Safe Playback Queue

**Upgrade baseline:** the exact WASP v18.1.5e full source. No new D1 or R2 schema changes, no Docker volume changes, no audio file modifications.

## Artist page

Open any artist at `/#artist/<artist name>` to see:

- A wide, dark artist hero, sourced from the existing artist artwork/fallback system. It is not a Spotify verified badge.
- **Popular**, ranked by currently available HIVE-catalogue play totals where nonzero counts exist. Without confirmed counts, display available artist tracks instead. Only playable, deduplicated catalogue songs are shown. No third-party popularity numbers are invented.
- **Discography**, using available release-year metadata for descending release ordering. Releases without verified years follow dated ones; upload time is only a tie-breaker. Type tags take priority over conservative single/EP inference. The main artist page previews up to eight items with **All / Albums / Singles & EPs** filtering, release-date/name sorting, and grid/list toggle. **Show all releases** opens the full discography. Grid tiles expand an album's available songs; List view shows each release with its individual songs and a Play release control. A partial album is not described as complete.
- **Featuring [Artist]**, showing local, public-user, and synchronized peer playlists containing at least one playable artist track. Private playlists belonging to the signed-in owner may also appear once loaded on that client. Music remains on its original server.
- Original **Biography / Lineup / Similar artists** tabs below the music content.

The official Spotify API changelog removed the Artist Top Tracks endpoint from the relevant developer-mode APIs in February 2026, so this release uses HIVE counts instead. It does not scrape Spotify or require API keys.

## Queue & playback recovery after refresh

The current queue order, playlist context, shuffle/radio order, current track, saved playback offset, repeat setting and counted-listen flag are saved in **per-tab sessionStorage**. Up Next panel visibility also survives reload. The player's fixed `<audio>` is never recreated by in-app navigation.

After refresh, WASP waits until it has finished loading local and synchronized peer metadata, restores still-addressable queue IDs, shows the saved track, and leaves playback **paused**. Clicking Play resumes the track from the saved offset using the existing HIVE smart-routing and source-failover logic. A reload by itself never autoplays, restarts a radio mix, or marks a track as newly played.

**Scope and limitations:** Queue recovery is for a browser tab on the same deployment/origin, not cross-device synchronization. Closing the tab ends its session in typical browsers (browser session restoration may preserve it). Missing/unavailable track IDs are skipped rather than inventing audio; temporarily unavailable remote peers may still fail to stream. Entries older than 30 days are ignored. The queue is bounded to 3,000 IDs to protect browser storage. Clearing browser session data removes the saved queue. Signing out in the player tab clears the saved queue.

## Verification

- Unit tests for HIVE popular ordering, album type/date grouping, artist playlist discovery, queue snapshot validation, deduplication and restored position.
- Desktop/mobile isolated Chromium checks for discography controls, HIVE playlist tiles, previous-session queue recovery without autoplay, and Play resuming the last position. These checks use a simulated same-tab reload because sandbox browser policy blocks ordinary test-origin navigation; they are not an end-to-end deployed reload test.
- Existing backend/API and selected previous browser regressions.

## Rollout

Deploy to Test first and try an actual browser refresh while playing a user playlist, then Radio, then a peer playlist. Verify that Up Next and playback position recover and manual Play works; ensure no automatic playback. Open an artist with both albums and singles, filter/sort the discography and check featuring playlists. Preserve Cloudflare D1/R2, secrets and Docker persistent volumes. Do not run `docker compose down -v`.

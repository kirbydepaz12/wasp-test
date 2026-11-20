# WASP v18.0.5 — Public HIVE Radio & Playlist UI Refinement

This staging update builds **only** on v18.0.4. Back up your D1/R2 or Docker `.wrangler/state`, uploads, music mappings, playlists and settings before upgrading. The optional v18.0.4 MusicBrainz offline index is unchanged. Existing audio files remain untouched.

## Public HIVE Radio (`/#radio`)

The **Radio** navigation link appears between **Playlists** and **Most hearted**, using the supplied `public/nav-icons/radio.png`. All visitors can generate browser-only playback queues. Radio is independent of login and does not save rows, playlists or duplicate audio when generated.

- **Artist:** Start with that artist and add available songs from similar artists (including supported genre relationships), without filling from unrelated performers when fewer songs are found.
- **Genre:** Check multiple genre tags, generating songs that match at least one selection.
- **Decade:** Match known 1850+ release years in a selected decade. Unknown years are excluded, never estimated.
- **Top songs:** Rank by all-time confirmed, deduplicated HIVE telemetry, not local upload count; only play songs that still exist in this installation's reachable catalogue. The top-100 aggregate is cached for five minutes.
- **Quantity:** 20, 30, 50, or custom 1–100. If fewer tracks qualify, show the actual number, notify the user and suggest contributing a server through the supported account publishing workflow.
- **Playback:** The full generated list is visible on `/#radio` and enters the persistent player / Up next queue. It survives navigation within the current page session but is not a permanent playlist.
- **Save as playlist:** Logged-in *member* accounts can register eligible HIVE peer references and save a new private playlist using existing ownership checks. Guests see a registration/login prompt. No audio is copied or deleted.

## Browsing and editor improvements

- Center Week/Month/Year/All time controls in each Telemetry tile.
- Move staged **Undo** and **Save changes** directly above the owned-playlist track list, not beside its cover.
- Render title, album, credited artists, verified year, available genre and duration in wide song rows. Smaller devices hide less important columns and keep artist attribution beneath the title.
- The bottom player artist credit is an accessible link. Single-artist playback opens the artist details; multiple credited performers navigate to `/#artists` with a comma-separated multi-name filter. This filter is not enabled in other sections.
- Review potential playlist duplicates by title similarity and artist overlap, with a separate edition marker to avoid conflating live/remix variants. The owner must explicitly choose a candidate to remove; Undo remains available (five-step history), and the server is untouched until Save. Only playlist references are updated — no music files are deleted.

## Compatibility and security

The Radio page is public but uses no private member data. `GET /api/radio/top` exposes anonymous aggregate telemetry only and shares a bounded summary cache. `/api/tracks` supplies release years and genre labels only when present in established metadata tables, gracefully falling back to older installations. Existing HIVE routing, Cloudflare Workers, Docker and optional Mobile Bridge behavior remain in place. No database schema destructive migration is introduced.

## Staging verification checklist

1. `npm test` and `python tests/ui_v18_0_5_radio.py` on the source package.
2. Confirm the Radio icon renders in both expanded and collapsed sidebars, guest generation works, and Spotify / other browsing functions are unaffected.
3. Verify decade/genre/artist/top lists respect available songs, unavailable peers, missing years, and the 100-song limit.
4. Verify guest save prompts login and authenticated member save creates exactly one private playlist (and preserves peer track references).
5. Review duplicate suggestions in a real 300+ track playlist. Stage Remove → Undo → Save and check that no audio changes and the original source remains intact.
6. Verify center alignment and metadata columns at desktop, tablet and mobile widths, and verify player artist links for one and multiple artists.
7. On Docker, verify build, existing HTTP+HTTPS mappings and mounted volumes; on Cloudflare, verify available D1 quota and new cached aggregate endpoint.

**Limitation:** Matching and generating radio relies on available metadata. Some songs in a large Spotify/HIVE catalogue may lack release year or genre, so these modes can produce fewer than requested until metadata enrichment completes.

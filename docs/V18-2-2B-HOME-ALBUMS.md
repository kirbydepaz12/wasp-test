# WASP v18.2.2b — Home Albums Carousel

**Upgrade baseline:** exact WASP v18.2.2a. This is a UI-only update with no database migration or change to music objects.

## What changed

The `/#home` landing page now presents the sections in this order:

**Artists → Albums → Songs → Playlists**

Albums use the existing home-carousel layout, controls, artwork handling, and mix of recently added / highly played / other available content. Their cards contain square artwork, release name, album artist, available track count, and local/HIVE source indicators. A card opens its normal `#album/<artist>/<album>` page; **Show more → All albums** opens the existing complete album grid at `#recent/albums`.

## Multi-artist releases

The Home album list uses the same cached release grouping as the existing Albums grid and album-level reactions. Soundtracks and collaborations with different song performers remain grouped as one release. Ambiguous, generic release titles retain the existing artist-disambiguation rules. Clicking a compilation still opens its full available track list, including other contributing artists. It does not duplicate any MP3 or change song credits.

The home mix uses existing creation dates and aggregated HIVE play counts. The random remainder is intentionally mixed, just as with the other Home rows. No Spotify/Deezer call or extra database query is made to build the row; it operates on the catalogue already loaded for Home.

## Testing and limits

- Desktop and phone-width Chromium checks verify section order, multi-artist release grouping, album navigation, All albums navigation, search filtering, and preservation of existing Songs/Playlists rows.
- The existing backend suite and selected browser regressions should continue to pass.
- The carousel reflects metadata available on the connected WASP server and its synchronized peers. Missing tags can prevent a release from appearing, and newly synchronized peers require a catalogue refresh.
- RSS is not included in this release; its scope will be defined separately.

## Deployment

Test `/#home` on Test WASP before Docker or Main. Preserve Cloudflare bindings and Docker volumes. No storage reset, audio reupload or new configuration variable is required.

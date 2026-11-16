# WASP v16.0.6 — Album and Subsonic compatibility hotfix

## Scope

1. Soundtracks/compilations on `/#recent/albums` are grouped by normalized album title rather than the track performer's exact name. Generic titles remain artist-scoped; album pages open the full grouped record. This is a metadata heuristic, not MusicBrainz release matching. Albums with identical distinctive names but genuinely different recordings can still merge; this release does not delete or modify music files.
2. Desktop sidebar retains scrollability but hides the native scrollbar during expand/collapse. Border divider remains visible; narrow/mobile layout is unchanged.
3. Mobile `star`/`unstar` store account hearts locally in both `user_song_reactions` and the same `reactions` account voter identity the web player uses. Peer stars use stable, origin-specific WASP reaction IDs and never mutate the source peer. Browser guests have their own anonymous reactions; signing in allows account-scoped hearts to synchronize. Account deletion cleans up account-voter reactions.
4. `getStarred`, `getStarred2`, song `starred`, `getArtist`, `getArtists`, search artist metadata, `getCoverArt` for artist IDs, and `getArtistInfo(2)` now expose compatible data. Artist biography requests trigger native cached Wikipedia lookup when needed; peer-only artists may fall back to a trusted source's public `/api/bio`. Peer requests do not receive mobile passwords or cookies. If sources have no biography, empty results remain possible.
5. Admin Advertising → **Insert sample slider** now provides the agreed six-slide HIVE example (join the swarm at slide 5, shuffle at slide 6). Existing saved custom ads are unaffected.
6. Playlist-list artwork and its Android-client-specific behavior are out of scope, per request.

## Safe validation

- Apply the patch to **v16.0.5 only**, preferably on staging. Check `/api/admin/version` for `16.0.6`.
- On `/#recent/albums`, confirm the same multi-artist compilation appears once and that opening its tile lists songs by multiple performers. Check a generic `Greatest Hits` remains artist-separated.
- Collapse and expand the desktop sidebar, including with tall credits. Check no native scrollbar flashes and scrolling still works.
- Sign into the same WASP account in the browser and Android. Heart and unheart both a local and peer-only track, refresh both clients, and confirm changes synchronize with the same account. Different accounts and logged-out guests should remain independent. The legacy browser's cached state may take one polling cycle to update.
- Search an artist in Android, verify artwork via `getCoverArt` and `artistImageUrl`, then open bio. Test a peer-only artist; unavailability should fall back gracefully. Confirm no mobile credential is forwarded to peers.
- Do not reset Mobile Bridge secrets or remove existing Docker volumes. Do not assume a v16 staging release is approved for v15 direct replacement.

## Limitations

- The database historically stored account hearts without their original timestamps. Older hearts therefore use an explicit epoch fallback in Subsonic `starred` metadata; this is a compatibility marker, not an assertion of when the user pressed heart.
- Some mobile clients ignore optional artist-image fields or cache responses. Refresh the client when testing. Other Android client-specific features, including playlist-list thumbnails, depend on the particular app implementation.
- This hotfix is locally tested; the user's actual live Docker/Cloudflare peer network and Android app have not been accessed or modified by the patch.

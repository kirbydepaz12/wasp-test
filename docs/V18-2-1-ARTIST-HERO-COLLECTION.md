# WASP v18.2.1 — Artist Hero & Spotify Collection Assembly

## Artist hero and navigation

The selected artist page keeps its picture as the background of the expanded hero banner, with the artist name, available-song/release counts, and **Biography**, **Lineup**, and **Similar artists** tabs *inside* the picture. All supplied lineup members render in a responsive, wrapping grid; there is no fixed-height cutoff. The similar-artist preview shows up to nine artists and offers **Show more** whenever more are returned; that link opens the pre-existing complete similar-artists page. The hero picture opens into an image dialog with an explicit Close button, Escape support, and outside-click dismissal. Clickable individual credited-artist names in song rows open that artist’s page, including featured performers.

The existing Popular, Discography, Featuring artist playlists, and player controls remain below the banner. For non-generic multi-artist releases, the artist Discography view includes all locally catalogued tracks sharing the release title, even when another track credits a different performer. Generic release names are excluded from simple title-only expansion to avoid accidental grouping. If an audio track is missing entirely, its metadata will not be synthesized as a playable track.

## Spotify-guided Add Music

Go to **Admin → Add music**, select **Album** or **Playlist**, then search for the Spotify album or playlist. Administrator-configured Spotify credentials under **Admin → Requests → Spotify** are required. API permissions and rate limits may prevent search or make the returned playlist partial; WASP shows those limits instead of treating withheld entries as missing. WASP only reads Spotify metadata; it does **not** download Spotify audio or guarantee Spotify artwork licensing.

Select the reference to inspect its returned track manifest. Drop or choose MP3 files, review the suggested file-to-track assignments, manually correct uncertain matches, and click **Upload selected MP3s**. The importer preserves the MP3’s performer credits and uses the selected album as the release for album-mode imports. If a file’s exact full-byte hash is already stored, WASP *does not upload the bytes again*: playlist-mode imports attach the existing track to the selected playlist; album-mode imports explicitly set the existing track's album and track number. For renamed or retagged MP3s, this exact-byte lookup may fail even when the recording is the same; use the separate manual **Use existing track** button after confirming the correct track in the local catalogue.

The **Use existing track** action is intended for an administrator-confirmed association. Existing tracks retain their identifiers, performer metadata, and audio objects. **Album reassignment changes the track's displayed album**, rather than creating a second audio copy; the previous album and track number are stored in an administrator-only attachment-history table and can be undone via the API. For playlist requests, WASP uses an existing same-named playlist when available, or creates one if needed. **Request missing** creates an independent, deduplicated song request for a known missing entry; the program does not assume inaccessible Spotify track lists are complete.

## Security and performance

All Spotify lookup, collection attach, and missing-track request APIs require the existing WASP administrator session. Artist picture and profile behavior uses the existing biography and artwork services; no new private data feed or external Artist API is required. No background audio download, automatic playlist deletion, album file rewriting, or Docker volume alteration occurs. Existing queue persistence from v18.2.0 is preserved.

## Testing and limitations

Node/backend tests, browser validations at 1360/768/390 pixels for a 19-member lineup and 24 similar artists, and desktop/mobile administrator Spotify-manifest UI mocks are included. Live Spotify credentials, Cloudflare D1/R2, EC2 Docker, and current production peer catalogues have **not** been exercised end-to-end. Use Test WASP first; back up its database before changing album associations. The existing v18.2.0 source and its ZIP remain the rollback path for artist UI if necessary.

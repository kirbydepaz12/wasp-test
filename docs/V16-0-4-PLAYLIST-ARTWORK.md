# WASP v16.0.4 — Playlist artwork compatibility hotfix (STAGING)

## Why this update exists

The Android Subsonic music client can connect to WASP v16 and display server and user playlists with their song entries, but v16.0.3 omitted the `coverArt` identifier from the Subsonic playlist response. The client therefore showed a generic music-note tile. This update corrects the API response and supplies the requested image bytes through `getCoverArt`.

## Changes

- `getPlaylists` and `getPlaylist` emit an opaque, stable `coverArt: pl:<playlist-id>` for every playlist visible to the signed-in account. No source URL, device secret, or private peer address is included in the metadata.
- `/mobile/rest/getCoverArt.view?id=pl:<playlist-id>` (and `/rest/getCoverArt`) checks the same user authorization as the playlist listing. Other members' private playlists and their covers cannot be fetched.
- Server-managed playlist images are fetched from the existing R2 object `art/playlist/<id>` when a custom cover is set. Member playlist images use `art/user-playlist/<id>` when a standalone cover is selected.
- Synchronized public peer playlist covers are fetched on demand via the **approved source's** existing `/art/playlist` or `/art/user-playlist` endpoint. No mobile key, session cookie, or Authorization header is sent upstream. Redirects are not followed and arbitrary cover URLs are not used as upstream hosts.
- If a playlist has no standalone image, its first accessible track's normal WASP track art is used as a fallback. That may be a track thumbnail rather than the webapp's JavaScript-generated nine-tile mosaic.
- OpenSubsonic `readonly: true` is reported for playlists because this staging compatibility layer supports read-only playlist access.
- All changes are additive to the API layer; no music, playlist rows, peer snapshots or existing mobile keys are altered. No new database migration is required.

## Installation

1. Apply the v16.0.4 artwork hotfix over **exact v16.0.3** in the separate staging repository, or deploy the v16.0.4 full staging package.
2. Rebuild and deploy the Worker/static assets. Keep the same D1, R2 and persistent Mobile Bridge secret; do not reset the secret or regenerate device keys.
3. Open Admin → Network → Connected Peers; synchronize the trusted peer sources if previously unsynchronized. This fix does not itself re-sync the catalogue.
4. In the Android client, refresh the server playlist library and clear cached playlist images if needed.
5. Verify a server playlist with uploaded art, a member playlist with uploaded art, a public peer playlist whose source exposes art, and a playlist without custom art. Check `getPlaylists`, `getPlaylist`, and authenticated `getCoverArt` responses. Test a peer-only song for correct playback and seeking separately.

## Verification and limitations

Node regression tests cover `coverArt` metadata, fetched PNG/JPEG bytes, no-art fallback, private-playlist isolation and credential stripping on peer artwork requests, plus existing mobile/P2P functionality. These tests do not establish universal compatibility with every Subsonic client. The uploaded Android screenshots verify successful connection and playlist entries **before** this artwork fix, not that artwork has been verified on-device afterward. A few clients only refresh thumbnails when their local image cache is cleared.

This is still a staging release. Do not replace the current v15 production Worker without a separate production-migration rehearsal and backups.

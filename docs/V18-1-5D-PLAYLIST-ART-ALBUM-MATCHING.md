# WASP v18.1.5d — Playlist Track Artwork & Album Request Matching

Upgrade baseline: exact WASP v18.1.5c source. No schema migrations.

## Playlist cover: select an existing track image

Open a playlist you own, choose **Edit playlist**, and select **Choose from playlist tracks** in the Playlist image section. Search for a song, select its album artwork, and use **Save changes**. WASP copies the image bytes into its existing server-managed playlist cover storage. This does not copy or edit the audio. The chosen cover remains after the source track is removed or unavailable because the image was copied. The current **Use album-art grid** and **Upload a custom image** options are unchanged.

Only tracks present in that particular playlist are offered. The browser retrieves the displayed artwork, validates that it is JPEG/PNG/WebP and below 5 MB, then sends it through the existing owner-only playlist-cover upload endpoint. On a private peer whose artwork is not accessible through browser CORS, the user receives an error without replacing the existing cover; use a configured peer relay, or upload an image manually. On large playlists, search to filter the candidates. Album artwork already missing on the source track cannot be copied automatically.

## Album requests: find potential matches

Admin → Requests now offers **Find potential match** on local album requests. The search scans existing local tracks and **synced connected HIVE peer snapshots**, grouping candidate tracks by album and source origin. Matching candidates show album name, credited artist, group track count, score and origin. The administrator may reject misleading candidates, or confirm an album group.

An album group with one or more tracks **does not prove the complete requested album exists**. Confirming a candidate stores the selection and keeps the request active. After reviewing album completeness, the administrator can use the existing **Mark as done** action. Rejected candidates remain excluded on subsequent searches; refreshes retain the selected album and other review details. Remote-originated requests stay owned by their originating WASP, and are not modified through local matching.

## Compatibility and safety

- No schema changes; confirmation and rejection records are in the existing request JSON metadata.
- No changes to MP3 files, streaming, Docker volumes, Cloudflare R2 audio, playlists, hearts, reactions or telemetry.
- Copied artwork uses the existing R2/local MUSIC playlist-cover key. User ownership and the current 5 MB image limit are enforced by the existing upload endpoint.
- No new environmental variables, no migrations, no automatic peer synchronization.
- Existing album-art grid and custom upload continue to work.
- Perform rollout on Test before Main and Docker. Back up persistent databases and Docker volumes. Do not run `docker compose down -v`.

**Version:** v18.1.5d · Playlist Covers & Album Matching.

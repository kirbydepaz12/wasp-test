# WASP v17.0.4 — Spotify Request Completion Fix

## Problem addressed

The test Cloudflare Worker returned HTTP 409 for `POST /api/admin/requests/{id}/complete` for a Spotify playlist showing `50/50+ · 50 local · 0 missing`. v17.0.3 sets `partial` whenever an embed exposes **exactly 50** or **100 or more** tracks, and rejects any partial request without giving the administrator a safe way to finalize only the visible subset. The admin UI also mislabels some completion errors as `Couldn't refresh.`

## Behavior in v17.0.4

- Extract optional **playlist-level** track count from the public Spotify embed's playlist entity when present. Do not guess a total from unrelated nested objects or infer an exact length merely from receiving 50 tracks. When the reported total equals the retrieved list length, classify the list as **verified**; when it exceeds the retrieved list, classify as **known incomplete**.
- Keep compatible behavior for existing shorter public-embed lists when no exact source total is available. Such lists are *not* advertised as cryptographically or independently verified.
- For an unverified boundary-sized list (including existing stored v17.0.3 requests with only `partial=true`), when **all retrieved songs are locally or remotely available**, display **Finalize N retrieved songs…**. A separate admin confirmation states that the full Spotify playlist length is unknown and additional Spotify songs will not be included. The completion API requires `{ "confirm_unverified": true }`. The acknowledgement, retrieval count and timestamp are stored in the request's existing JSON metadata for auditability. The completed request moves to Previous requests.
- A known-incomplete playlist (e.g., Spotify reports 70 but its embed provides only 50) **cannot** be finalized even with the override. Likewise, a request with any missing retrieved songs cannot be finalized. The request stays in the active queue, with a helpful explanation.
- The admin interface displays the API's specific `error` message, or a fallback with HTTP status, for both Refresh and Completion. It no longer calls completion failures `Couldn't refresh.`
- Admin-created playlists keep their matched tracks in Spotify's retrieved order, accept local/peer references as before, and retain the existing Spotify image fallback. No music is uploaded, deleted or copied as part of this fix.

## Known limits

Spotify's public embed is not an authoritative complete-song API. Spotify might omit songs or change its shape at any time. An *unverified* completion intentionally creates a playlist **only from the retrieved tracks**, even when additional songs exist on Spotify. Previously imported private user Spotify playlists are not changed by this admin request fix. For lists of fewer than 50 visible tracks with no reported total, v17 preserves existing completion behavior even though the overall Spotify total isn't independently verifiable.

If the public embed cannot provide a complete source count, obtaining a truly verified playlist may require a future authorized Spotify integration or user-supplied list. Do not claim that a manually finalized subset represents every song in the original Spotify playlist.

## Upgrade and rollback

1. Back up your D1 or Docker persistent database state. Make a Git commit or backup of exact **v17.0.3**.
2. Apply the **v17.0.3 → v17.0.4 changes-only patch** to that exact baseline, or use the full v17.0.4 source on a separate staging branch. Keep Docker music, DB, settings and peer volumes mounted as before.
3. Deploy test Worker and open **Admin → Requests → Request queue**. Open a 50/50+ completed-visible-song request. Verify that the new **Finalize N retrieved songs…** button and explicit warning appear. Confirm, and verify it appears in Admin Playlists and Previous requests.
4. Confirm that requests with missing songs stay pending and that a playlist with a known higher source count does not offer the override.
5. Verify peer playback and ordinary audio navigation still work. No player source, streaming endpoint or peer sync was modified in this patch.

No SQL migrations or media transformations are needed. Rollback is a code redeploy of v17.0.3; previously completed playlists and requests remain stored.

## Local validation

- `node --test tests/*.test.mjs`
- `python tests/ui_v17_0_4_spotify_completion.py`
- `python tests/ui_v17_playback_continuity.py`

The local tests use mocked Spotify responses and a local sqlite-like test database, not your live Cloudflare Spotify playlist. Production behavior still requires a real staging verification.

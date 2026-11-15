# WASP v15.0.9 — Currently Streaming and uncapped listener totals

Incremental update on top of **v15.0.8**. This release implements the approved `/#listened` UI designs and caps only the **displayed songs**, not the number of active listeners.

## Listening activity pages

- `/#listened` keeps the **Recently listened** subtab selected. It shows a *single horizontal row* of **Currently Streaming** song cards above the normal listening history. The number of cards changes with available screen width; when overflow exists, the last cell is a circular `•••` **View currently streaming** link.
- `/#listened/streaming` shows the dedicated **Currently streaming** subtab, with at most **30 distinct active songs**. The newest **started streams** appear first. Heartbeat renewals do *not* reorder the list.
- Tracks active on several connected servers appear as one card. Listening-history timestamps and the existing pulsing streaming icon remain intact. The history icon can still indicate tracks older than the 30 currently displayed.
- A red oval at the top-right of the full streaming subtab shows the **total active playback sessions** with a white person icon, directly to the left of the green **LIVE** badge. **30 is not a listener-count limit.** For example, 65 active playback sessions can be represented by 30 cards and a red `65` badge.
- Browsing between listening subtabs does not unmount the audio element, change the queue, or stop playback. Live activity refreshes around every **5 seconds** while the listening page is open.

## Presence, counting, and privacy

- A session represents one active WASP browser/player playing audio; it is not a unique person or every visitor who simply has WASP open. If one person plays in two tabs, those are two playback sessions. This avoids collecting usernames and personal identifiers.
- `GET /api/active-streams?summary=1` returns an **independent full active-session count** and up to the 30 newest distinct active songs per server, with start timestamps. The response also contains song keys (without session IDs) to preserve listening-history streaming badges on older currently playing songs.
- WASP combines server summaries from its configured, reachable peers. Multiple sessions on the same song count separately in the red badge even though the song gets only one card.
- Peers still running earlier WASP releases return the old array format, so their counts can only be estimated as a lower bound. An unavailable peer also makes totals incomplete. In both cases the badge displays `+` (for example, `12+`) until those peers upgrade or reconnect.
- The legacy `GET /api/active-streams` **array response stays unchanged**, and Docker's existing allowlisted peer route already permits the new read-only summary query.
- Sessions disappear on pause, stop or after their 65-second timeout. No raw listener identities, usernames or session IDs are returned by the public summary endpoint.

## Database and deployment

The existing `active_streams` table is retained and receives one additive `started_at` INTEGER column. The isolated `wasp_live_streams_schema` marker moves from `1` to `2`; the migration is automatic and does not alter the music library, playlists, requests, accounts, play counts, or other migrations. Existing active records continue working; after a track change its fresh start time is recorded.

For an existing **v15.0.8** installation, back up the application and database, apply the upgrade patch to the existing source tree **without deleting other files**, rebuild/redeploy your Cloudflare Worker or Docker image, and refresh the browser to load `app.js?v=15.0.9` and `style.css?v=15.0.9`. Use the full archive for a fresh copy. Do not delete Docker volumes and do not reset D1.

The v15.0.8 HTML-backed Account Settings modal and the separate public **Request** page are preserved unchanged. Do not confuse the red total with the number of authenticated users: anonymous listeners are included, and inactive visitors are not.

## Verification

- `node --test tests/v15_0_9_streaming_cap.test.mjs`: >30 unique songs, independent listener count, deduplication, newest start order, session heartbeat, expiration, legacy compatibility and privacy.
- `python tests/ui_v15_0_9_currently_streaming.py`: one-row preview, overflow navigation, 30-song cap, red user counter beyond 30, recent playback indicators, Request visibility and persistent audio.
- Run the prior `tests/ui_v15_0_8_account_modal.py`, `tests/ui_v15_0_7_recent_live.py`, and full Node suite to catch regressions.

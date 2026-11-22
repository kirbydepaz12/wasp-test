# WASP v18.1.1 — Public announcements and local telemetry refresh

An additive refinement on **v18.1.0**, with no destructive migrations or changes to Docker volume mappings, Cloudflare D1/R2 bindings, user playlists, music or HIVE peer identities. Install on Test before Main. The older `/api/user/announcements` endpoint remains available to older signed-in clients; the new public client uses `/api/announcements`.

## Announcements for everyone, not just registered users

Under **Admin → Users → Announcements**, the admin still chooses a template, edits a required title and message, chooses a severity and opacity (50–98%), sees the live preview and presses Send. A new **server-local public** read-only API, `GET /api/announcements`, shares the last 20 announcements from the preceding 30 days without user data. No account, session, browser ID or peer federation is required. Only the admin may create messages through `POST /api/admin/announcements`. Messages are never distributed to other HIVE servers.

The player checks the public feed every **two seconds while its tab is visible**, and immediately when the tab regains focus or network connectivity. A shared two-second edge cache reduces repeated Cloudflare D1 reads when many visitors are present. This is **near-live polling, not a guaranteed instantaneous WebSocket push**: delivery may take several seconds depending on edge caching, network availability and browser throttling. No background push is delivered after the page is closed.

The notice appears near the lower-left corner above the player for up to 30 seconds; visitors can dismiss it sooner. The origin-scoped browser cache records a notice as handled **only after dismissal or completion of its display**, not when the notice first appears. Refreshing the page during its 30-second display resumes the notice rather than making it vanish. Later/new messages are shown even after earlier ones are handled. An announced notice may preempt an earlier one; the earlier notice resumes with its remaining display time. A small bell/music-note control on the notification lets visitors mute or enable the optional ding, saved locally in the browser.

### Optional notification ding

A quiet, original Web Audio two-tone beep (~170 milliseconds) is played when a notification is displayed **only when the browser permits sound**. Browsers typically require the visitor to interact with the page first. The beep has an independent low-gain audio graph; it does not pause music, alter the music volume or play tracks. The sound can be muted per browser. If the browser blocks autoplay, announcements still appear silently.

## Update current telemetry

Under **Admin → Network → Telemetry**, next to the selected-peer pull controls, click **Update current telemetry**. The admin-only `POST /api/admin/telemetry/recalculate` invalidates this server's cached telemetry summaries and metadata-coverage snapshot, then reports the **current local** and **Entire HIVE** confirmed-play counts from the existing retained event ledger.

This button **does not** pull remote events, record fake listens, enrich music, modify origin IDs, or delete history. Use **Pull telemetry from selected peers now** to import remote events, and **Update current telemetry** to rebuild calculations from events already on this WASP server. The HIVE event uniqueness rule still deduplicates imported plays, and scheduled synchronization remains under Crons.

## Verification and limitations

Run `node --test tests/*.test.mjs`, `python tests/ui_v18_1_1_public_announcements.py`, `python tests/ui_v18_1_0_server_communications.py`, and the existing Radio, star ratings, metadata and player continuity browser tests. These tests run on isolated databases/mocked browser APIs; they cannot guarantee real Cloudflare/Docker production behavior or network latency. Test sending an announcement from an admin session to a guest/private browsing session on the same WASP domain before rolling to Main. Verify the notice appears, persists across refresh until handled, can be dismissed, and that a second announcement arrives after the first. Check that a different WASP domain does not show it.

> No WebSocket or Durable Object binding is introduced. Real sub-second broadcast to browsers across all Cloudflare POPs would require a stateful push/broker service and further deployment configuration.

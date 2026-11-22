# WASP v18.1.0 — Server identity, selective HIVE telemetry and local announcements

This is an additive refinement built **only on v18.0.9**. Upgrade on Test first, preserve existing Cloudflare D1/R2 bindings and Docker state volumes, and never use `docker compose down -v`. Existing music, playlists, users, history, hearts, ratings and request data are retained. No background action is performed merely by opening the admin page.

## Server name vs browser tab name

Under **Admin → General settings → Branding**, **Server name** still controls the top-left text (or label when using a custom image). It is also the name announced to administrator-connected HIVE peers via `/api/peer`. **Browser tab name** changes the HTML document title for listeners browsing this particular server; it is not used as its identity in the connected peers list. Existing settings keys (`site_name`, `tab_title`) are preserved, so no migration is required for branding. The peer handshake's historical `title` alias now mirrors the server name to avoid advertising the local browser title to other administrators. As with earlier versions, the public `/api/site` endpoint still returns the browser title so local browsers can display it; it is not intended as a secret.

## Selective manual telemetry pull

Under **Admin → Network → Telemetry → Telemetry**, click **Select all peers** or check specific **administrator-connected** peers, then **Pull telemetry from selected peers now**. A refresh button reloads peer names and last-known states. The UI shows import counts, failures and progress. More than 10 selected peers are processed in sequential bounded groups; an interrupted run can safely be retried. The API `/api/admin/telemetry/peers` lists only managed peer URLs to an authenticated administrator. `/api/admin/telemetry/pull` accepts a validated array of 1–10 managed peer URLs per invocation; it cannot be used to fetch arbitrary internet URLs or community-submitted endpoints.

The existing `telemetry_events` ledger keeps the source's `origin_id` and `event_id` uniqueness constraint. Imported events contribute to **Entire HIVE** totals, including those also imported through another peer, without becoming duplicate plays. Imported events do not change the **This server** scope. Newly imported events invalidate cached telemetry summaries so a manual dashboard refresh shows updated numbers. Peers must be online and allow telemetry sharing to supply feeds. Historic partial feeds, inaccessible peers and events beyond the source retention limit cannot be filled in automatically.

The existing **Network → Crons** settings are separate: the telemetry sharing checkbox controls public feed exposure and automatic scheduled sync. Manual pulls do not change the cron schedule or the peer's sharing settings. The current HIVE model is a peer-exposed read feed plus receiver-initiated pull; the crons UI calls this “PUSH / sharing” for convenience, not a direct transfer initiated by the source.

## Local announcements to registered users

Under **Admin → Users → Announcements**, admins can send a **required title** (up to 100 characters) and **required message** (up to 2,000 characters) to registered users on **this server only**. Messages do not appear in peer catalogue, telemetry or metadata feeds and are never replicated through HIVE. The message creation page contains six editable templates (planned downtime, new uploads, requests being fulfilled, feature update, service restored, urgent notice), a theme-aware severity choice, a 50–98% opacity slider, and a **live preview** that updates while typing. Confirm the Send action to save a new message to the server's local database. Previous messages can be reviewed in the admin panel.

When a signed-in user opens their account, WASP checks for recent announcements; the visible app checks again roughly once a minute while in use. A new message appears above the player at the lower-left corner for **30 seconds**, or until the user closes it. Each browser saves the IDs of displayed messages in `localStorage` under a username-scoped key, so a normal reload or app update does not replay announcements that have already been viewed or dismissed. Other browsers or devices may show the same announcement independently, and clearing browser data may make it reappear. The server retains announcements up to the most recent 30 days for user delivery; the admin list retains the most recent 30 by creation date. Newly registered users do not receive notices sent before account creation. Guests and administrators do not receive the account-targeted overlay.

Announcements are plain text: HTML and scripts are not executed. This feature adds a single additive `server_announcements` D1/local database table and does not modify music or account records. When sending multiple notices, each is queued for display rather than overlaying the previous one.

## Testing

```bash
npm test
python tests/ui_v18_1_0_server_communications.py
python tests/ui_v18_0_9_radio_wheel.py
python tests/ui_v18_0_8_star_rankings.py
python tests/ui_v18_features.py
npm run build:docs
```

The automated tests use isolated SQLite and in-memory Chromium mocks; they do **not** prove that production Cloudflare Worker/D1/R2, Docker, Nginx bridge or live peers work identically. On Test WASP, verify actual user logins, cross-peer import counts, the new announcement display, and browser cache behavior before updating Main. D1 reads/writes from manual pulls and announcement polling are still subject to Cloudflare account limits.

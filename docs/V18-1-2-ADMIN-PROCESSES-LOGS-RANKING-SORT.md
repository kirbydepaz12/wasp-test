# WASP v18.1.2 — Admin processes, audit logs and ranking sort

An additive upgrade from the exact v18.1.1 baseline. **No music, playlists, Docker volumes, Cloudflare D1/R2 bindings or HIVE peer identities are reset.** Test on a staging Worker/Portainer stack before production.

## Navigation and layouts

- The admin sidebar now displays **Network, Metadata, Telemetry**, followed by **Running processes**, **Danger**, and **Users & Announcements**.
- Under **Running processes → Processes**, monitor currently tracked WASP activities, including active administrator API operations, the HIVE metadata scanner, SHA-256 folder hashing, manual Cron jobs, and Docker's offline MusicBrainz download/indexing operation when available. Status is refreshed while the tab is open. Completed Cron jobs from the last 24 hours remain visible for context.
- This is **application activity**, not a list of every Linux/Docker process, CPU usage or all Cloudflare Worker runtime tasks. Worker deployments cannot inspect operating-system processes. Some short-lived automatic scheduled functions do not maintain an observable running status.
- The registered users table fits desktop widths by grouping the existing heart, legacy like/dislike, playlist and link counts into compact cells. Mobile screens use stacked rows instead of forcing a horizontal table. All original stats and existing sort fields remain available.

## Administrator action logs

Under **Running processes → Logs**, review mutations to administrator API routes (method, sanitized route name, administrator name, timestamp and HTTP result). No request bodies, credentials, cookies, MP3 bytes or Spotify API secrets are logged. Unauthorized visitors cannot read, download or clear these records. Existing historical activity cannot be reconstructed retroactively.

The logs are stored in a new, additive SQLite/D1 `admin_action_log` table, and active actions in `admin_active_operations`. These are **local to this WASP server** and are not exposed in HIVE. The listing loads in pages; Download logs (.txt) fetches successive pages and downloads a UTF-8 text file in the browser. The Clear logs control requires confirmation and the exact phrase `clear logs`; it preserves a fresh audit entry recording the clear. It does not remove accounts, music, playlists, or other application tables.

Audit logging is best-effort and is not a substitute for infrastructure-level audit systems. It logs future successful and unsuccessful *authorized administrator requests*, not every page view, background Worker invocation, or actions that occurred before this version. Errors writing audit logs are reported to the application server log without rolling back an otherwise successful user action. The server does not automatically prune historic admin logs, so administrators can export and clear them periodically if D1 storage usage matters.

## Most/least rankings

On `/#stars` and `/#hearts`, each Songs, Artists and Playlists ranking has a **Sort by** selector next to the page heading. Select **Most stars / Least stars** or **Most hearts / Least hearts**. For **Most/Least stars**, the backend selects the correct ascending or descending top 100 *voted* entities (instead of reversing just the previous top 100). Switching between those orders requires an additional bounded, cached aggregate query. For **Most/Least hearts**, the browser orders the available reacted-song, artist and playlist catalogue before applying its display limit; it does not issue an extra database query. Only entities with at least one recorded heart or star vote are ranked; unvoted items are not included in "Least". Opening a different ranking category resets to Most. Existing heart and star votes are not modified.

## Verification

Run:

```sh
npm test
python tests/ui_v18_1_2_admin_ops_rankings.py
```

Check admin access isolation, logs after creating an announcement or changing site settings, the Confirm + Clear flow, downloaded UTF-8 `.txt` logs, metadata scan states, a narrow/mobile Users page and sorting both directions on Songs/Artists/Playlists. The automated browser tests are isolated Chromium tests; real D1, Docker startup and Cloudflare deployment are not verified by this package.

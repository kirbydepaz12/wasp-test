# WASP v17.0.2 — HIVE Requests, cron controls, source indicators and private Spotify recreation

## What changes

- `Admin → Network → Crons` has a **Run now** control and persisted execution status/progress for every maintenance job. The Docker SHA-256 scanner continues using its own read-only scan progress.
- **HIVE Telemetry** is the only newly enabled default maintenance cron: every **5 minutes**, with configurable 5/10/15/30/60/120-minute intervals. Unchecking **Share my telemetry with the HIVE** stops this server's public telemetry feed; **incoming telemetry is still pulled** by the scheduler/manual operation. Turning sharing off does not erase copies previously synchronized to other peers.
- Songs and artists display compact **local server**, **peer cloud**, or **both** source icons. Audio playback and peer music sources are unchanged.
- Public song/artist/album/Spotify-playlist requests are shared across approved administrator-managed peers and approved online member-published peers as origin-tagged, deduplicated *read-only* request records. New requests can be discovered after the next synchronization cycle. Requests are not removed when one server receives a peer event. The originating server retains final ownership of completion or cancellation.
- Spotify playlist requests include separate **local** and **peer** already-present track counts, based on saved verified peer catalogue snapshots rather than matching the playlist title alone. A playlist remains pending until explicitly completed; a partial match does not close it.
- Signed-in members can paste a **public Spotify playlist link under My Playlists → Private playlists**. The system creates a **private** playlist with the available Spotify cover image, inserts exact local/approved-peer matches in original order, and posts **only missing individual songs** into the federated request queue. The owner's *Refresh matches* checks for newly available tracks; *Mark as done* is owner-only and available only when all **known** songs match.
- Missing Spotify admin configuration variables are documented for both Docker/Portainer (`SPOTIFY_SETTINGS_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`) and Cloudflare runtime secrets. No real secret values are bundled.

## Important limitations

**Spotify's public playlist embed is not a reliable, complete library API.** The importer can process only the tracks Spotify makes available through the public embed; the embed may omit a portion of a larger playlist or change at any time. The importer refuses an empty song list, marks obvious 50-/100-track truncation as partial, and prevents final completion while known tracks are missing or truncation was detected. If the embed exposes a truncated list without an advertised count, WASP cannot infer omitted tracks. Imported music is referenced, **never downloaded or duplicated**. The source playlist cover is fetched only from approved Spotify image hosts.

Federated requests use the existing opt-in public network-sharing boundary, not an end-to-end authenticated account protocol. A malicious participating server may fabricate its **own** request or telemetry records; operators should approve peers they trust. The feed strips visitor tokens, user IDs, session credentials and private playlist data. Each receiving server treats remote requests as **read-only**. Music fulfilment depends on actual catalogue metadata and a reachable playable source, not merely on a peer stating “done.”

**Scheduled synchronization is eventual, not instantaneous.** Each run visits up to 10 peers (rotating through larger HIVE networks). Only suitable reachable v17.0.2 peers exchange request records; older v15/v16 peers remain music compatible but do not implement the new request feed. The host behind a private Tailscale bridge may not be reachable directly from Cloudflare. For multi-hop request sharing, each intermediate peer must run v17.0.2 and opt into public network sharing.

Cloudflare's `waitUntil` work has finite lifetime. If a manually started job is interrupted, the stored status reports an error after a timeout; retry the job and inspect the Worker logs. Long operations such as metadata checks process bounded batches rather than locking the web player.

## Deploy on staging first

1. Back up the staging D1 database or Docker state volume, user playlist data, and the current Git commit. Do **not** delete Docker volumes or overwrite production credentials.
2. Apply **only** the upgrade patch to the **exact v17.0.1 baseline** or use the full v17.0.2 source for a new staging installation.
3. In Cloudflare use runtime secrets, never build variables. On Docker define `SPOTIFY_SETTINGS_KEY` in the private Portainer environment (or retain the existing Docker `SCANNER_SECRET` fallback). Do not change an already-used encryption key or lose access to saved Spotify credentials.
4. Verify **Admin → Network → Crons**: only telemetry is enabled by default on a clean install, interval 5 minutes. Run a manual telemetry pull, check progress and last errors, and verify source sharing can be disabled without preventing a pull.
5. Connect two or more v17.0.2 staging servers and an approved member-published peer. Submit a request on one server and verify it appears on another, with the same origin/request ID and no duplicate after a relay loop.
6. Import a short public Spotify playlist as a signed-in member. Check private visibility, cover, exact local+peer matches, individual missing-song requests, automatic matching on later catalogue updates, and explicit owner completion.
7. Test source badges on local-only, peer-only and duplicated tracks; confirm peer playback, HTTP Range, Mobile Bridge and normal playlist playback still work during navigation.

Rollback: return to the previous Git commit and Worker build / Docker image. Schema changes are **additive** and should not be destructively rolled back. Restore the backed-up database only if data must also revert; don't revert or delete music volumes. Newly imported member playlists remain in the database unless explicitly removed by their owner.

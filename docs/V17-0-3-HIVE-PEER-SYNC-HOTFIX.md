# WASP v17.0.3 — HIVE Peer Sync Redirect Hotfix

## Root cause confirmed on Docker

The user's Docker D1 `telemetry_peer_cursors` table showed **both bridge peers stalled at cursor 0** with:

```text
Invalid redirect value, must be one of "follow" or "manual"
```

The same Docker container could retrieve `/api/peer` and `/api/telemetry/feed` successfully through Tailscale / Nginx using `curl`. The underlying problem was the unsupported Fetch API option `redirect: 'error'` in WASP v17.0.2, not the bridge, endpoint permissions or peer registry.

## Changes

- Use supported `redirect: 'manual'` for telemetry `/api/peer` and `/api/telemetry/feed` pulls, and federated HIVE request feeds.
- Explicitly reject all HTTP 3xx, opaque redirect responses and already-followed responses rather than following a redirect to an unapproved origin. Upstream 403/404 remain legacy/non-sharing peer skips.
- Apply the same safety-preserving correction to connected-peer catalogue revision checks for Spotify imports, approved Spotify playlist cover-image retrieval and the Mobile Bridge's optional peer biography fallback.
- Report build v17.0.3 in Admin and update asset cache-busting versions. No schema migrations, event conversions, cursor resets, new media fetches or audio-player changes.
- Add regression tests using a mock compatible with Wrangler's supported redirect modes, including rejected redirects and persisted error messages.

## Install and verify

1. Back up Docker's persistent state and any production D1 database before upgrading, and preserve credentials, volumes, peer URLs and Tailscale settings.
2. Apply this changes-only patch **only to exact v17.0.2** or deploy the full v17.0.3 project on a staging branch. Rebuild the Docker image; a container restart without rebuilding an old image will not install this fix.
3. Admin → Network → Crons → **Telemetry grab → Run now**. Confirm the operation reports at least one peer checked and ideally imported events. Source peers must have network/telemetry sharing enabled. Re-run if there are more than 200 outstanding events per peer.
4. Check Docker's locally persisted D1 cursor state using the existing Wrangler D1 config, e.g. `SELECT url,cursor,synced_at,last_error FROM telemetry_peer_cursors;`. Previously failed peers should advance beyond `0` and clear `last_error` when their feeds return valid events.
5. Check `/api/telemetry?period=year&scope=hive` for `connectedCaches`, `lastSynced`, `nodes` and `plays`. Aggregate JSON may be cached up to **five minutes**. Different years/time windows can hide otherwise imported data.
6. Test federated request pulls, peer playback, Mobile Bridge and browser audio continuity. The hotfix does not touch browser player logic.

## Operational caveats

- **Only incoming sync is fixed** for the private Docker-to-public Cloudflare path. A public Cloudflare Worker still cannot directly pull an unexposed Tailscale/private Docker service. A public, securely reachable route or an intermediary capable of propagating origin-tagged events is needed for reverse sync.
- Missing genre/artist country tags and missing peer ranking artwork involve separate metadata and art-routing limitations; this hotfix does not manufacture metadata or change artwork resolution.
- An HTTP redirect from any peer is deliberately rejected; fix the peer's registered base URL or Nginx upstream so `/api/peer`, `/api/telemetry/feed` and `/api/hive/requests/feed` return a direct HTTP 200, without redirects.
- Do **not** delete peers, clear `telemetry_peer_cursors`, drop D1 tables, wipe Cloudflare state, or delete Docker volumes to apply this update.
- Safe rollback: deploy the prior v17.0.2 image/commit; no schema change requires reversal. However the old redirect bug will recur until the hotfix is restored.
- Passing simulated tests does not prove a live Cloudflare Worker or AWS container deployment. Run the above real-peer verification before promoting to production.

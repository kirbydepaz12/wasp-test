# WASP v16.0.5 — Subsonic mobile presence (STAGING HOTFIX)

## Summary

This targeted update addresses the missing **Currently Streaming** status for music played through third-party Subsonic/OpenSubsonic Android clients. WASP's native browser player already sent anonymous play/pause heartbeats; the Mobile Bridge previously accepted Subsonic playback and completed scrobbles but never registered those sessions in the live-status table.

## Changes

- Successful authenticated `GET /mobile/rest/stream.view` (or `/rest/stream.view`) requests record one anonymous active session per **issued mobile app credential**, for both local and approved peer tracks. Existing stream proxying, Range responses and Web playback are unchanged.
- `scrobble` with `submission=false` (playback start) also records the presence. It **does not** increment completed listen counts; `submission=true` retains the existing confirmed-scrobble behavior.
- Each credential has a stable opaque session identifier. Seeking and subsequent byte-range requests for the same track don't inflate the listener count. When the client switches songs, the same credential's live entry moves to the new track.
- `download` and `HEAD` requests are never counted as playback; a failed peer stream isn't counted either. No account name, device ID, credential or listener IP is exposed through `/api/active-streams`.
- Entries use WASP's existing `active_streams` table and public summary endpoint. No schema migration or additional media storage is necessary. Native WASP browser heartbeats retain their current 65-second expiry.

## Limitation: approximate third-party streaming state

Unlike the WASP HTML audio element, third-party Subsonic clients do not reliably send pause, stop, or periodic heartbeat events. To keep short songs and normally buffered tracks visible, a Mobile Bridge session expires **15 seconds after the reported track duration**, bounded between **65 seconds and 6 minutes** (or 2 minutes when duration is unknown). Additional valid stream requests can renew it. This is a best-effort estimate, **not proof that sound is playing continuously**. Pausing, bulk prebuffering and offline cached playback may cause false positives or missed listening. Only sessions on servers whose `active-streams` endpoints are reachable as connected peers can appear in other servers' cross-peer dashboards.

## Deployment and verification

1. Back up your separate v16 installation's D1/R2 or Docker state and pin the current version. Apply this hotfix on top of **v16.0.4**, or deploy the complete v16.0.5 staging package.
2. Rebuild/redeploy the backend and static assets. Keep existing mobile credentials, Mobile Bridge encryption secret, network peers and music volumes. **Do not reset the database**.
3. Confirm `/api/admin/version` shows v16.0.5. In Admin → Network, leave the Mobile Bridge enabled, and use an existing valid device key in the Android Subsonic client.
4. Play a track from the **same WASP server's Mobile Bridge** and open `/#listened` in another browser. The streaming icon and listener count should show the song after the next normal refresh (up to ~10 seconds). Try a local song and an approved peer-only song.
5. For a dashboard on *another* WASP installation to show this activity, that dashboard must have the mobile-hosting WASP server registered as a reachable peer; activity isn't automatically broadcast to unrelated servers. Check `GET /api/active-streams?summary=1` on the mobile-hosting server first.
6. Pause and stop tests: a Subsonic client with no stop event may remain visible until the bounded expiry; this is an expected compatibility limitation, not an accurate continuous presence heartbeat. Verify the web player still stops its status promptly when paused.
7. Confirm `getPlaylist`, `getCoverArt`, `/audio`, and peer streaming continue to work as before. The hotfix does not modify play count, music files, playlists or federation state.

This release is locally tested, but real-device live presence still requires verification on the target Subsonic client. Do not promote over an older v15 production installation without a separate migration rehearsal.

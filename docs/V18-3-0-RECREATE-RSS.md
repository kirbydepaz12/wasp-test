# WASP v18.3.0 — HIVE Collection Recreation + Opt-In RSS

## Admin → Add music

The `Upload music` subtab preserves the existing **Singles / Playlist / Album** upload behavior and local file selection. No music upload logic has been replaced.

The separate **Recreate playlist / album** subtab retrieves publicly exposed reference lists (public Deezer catalogue album/playlist results and supported public Spotify album/playlist links). It does **not** download MP3 audio and does **not** require Spotify developer credentials.

Once a source is selected, WASP creates/reuses a durable draft, and scans the existing local library and synchronized authorized HIVE peer snapshots in bounded batches. A track is automatically assigned **only if its title and an entire credited artist match a unique, compatible recording**. If multiple versions qualify, none is auto-approved. For unmatched entries:

1. Search the existing local music and authorized HIVE peers, as in the Admin Requests workflow.
2. Confirm the correct recording manually; or request the missing track individually.
3. Use **Refresh HIVE matches** after peer catalogue sync or local music changes.
4. Use **Resume** to continue a saved draft.
5. Use **Done** beside Resume to archive the draft even when incomplete. This only removes it from Pending drafts. The created playlist, matched releases, user data and audio are never deleted. Searching the same source afterward starts a fresh draft (an existing playlist may require reuse confirmation).

A recreated playlist retains playable matches in its source order. For multi-artist albums, locally held tracks are linked by the new album name while preserving each original artist credit, and the previous album assignments are stored in the existing Undo history. Remote HIVE tracks are linked through a read-only album reference; no peer music files are modified or copied. Peer playback depends on availability and synchronized catalogue data.

## Admin → General settings → RSS

- **RSS is OFF by default.** When OFF, nothing new appears beneath Playlists on Home. All RSS tabs and configuration remain saved.
- Add, rename or remove as many tabs as practical within your database/account limits.
- Position tabs **Left / Center / Right**; left/right use angled treatments, center uses rounded pills.
- Select a tab, paste a public HTTPS RSS/Atom URL, or restricted **static** embed markup. The preview updates before saving. An explicit **Save RSS settings and tabs** publishes changes.
- RSS data is fetched **server-side**, parsed into text/headline/date/link/optional thumbnail, and cached in D1 for ten minutes (stale cached items may be displayed during a source outage). No arbitrary publisher HTML is rendered into the WASP DOM.
- Static embed snippets display in a restricted `sandbox` iframe **without script execution**. JavaScript widgets, credentialed/intranet feeds, HTTP feeds and non-public URLs are not supported. Some third-party embeds may refuse to load, and external RSS feeds can be rate limited or temporarily unavailable.

## Deployment and compatibility

- Upgrade from **exact v18.2.2b**; additive D1 schema and lazy creation on first use.
- Preserve the DB, R2 bucket, Docker volumes, user sessions, existing playlists and source metadata. Do not run `docker compose down -v`.
- Reconstructed albums may change locally stored tracks' album *metadata*, not their audio bytes. Undo history exists for prior album reassignment. If a peer goes offline, the remote audio cannot play until the peer returns.
- RSS feed fetches may consume Worker CPU and D1 operations on the first miss. Refresh requests use a server-side ten-minute cache, but real Cloudflare/Docker and third-party feeds still require validation. The manual HIVE rematcher also reads synchronized catalogue snapshots in bounded batches, which can be expensive in very large libraries.

## Suggested staging checks

1. Verify Upload music still accepts Singles, Album and Playlist files.
2. Search a known multi-artist album in Recreate, check strict auto matches, then manually approve a different HIVE peer entry.
3. Verify `Done` archives an incomplete draft but leaves the playable partial playlist intact. Recreate the same source again.
4. With RSS OFF, confirm Home ends after Playlists. Add two RSS tabs while OFF and verify they remain saved.
5. Enable RSS in Test; check Left/Center/Right, feed preview, tab switching and non-disruptive playback. Disable it and verify saved tabs remain.
6. Check RSS external failure, blocked private URL and script rejection; confirm no arbitrary HTML runs on Home.

RSS is disabled in existing installations until an administrator enables it. No live production deploy was performed as part of the source package.

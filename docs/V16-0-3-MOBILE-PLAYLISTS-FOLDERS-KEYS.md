# WASP v16.0.3 — Mobile Playlist, Folders & Short Keys (STAGING)

This is a staging update on top of **v16.0.2**. It does not alter the WASP-native player or peer protocol and must be verified with real Android clients and the production v15 peer network before any production migration. No MP3 is copied between peers.

## Changes

- **Playlist sources:** OpenSubsonic `getPlaylists` and `getPlaylist` now expose: WASP-managed server playlists (`playlists`/`playlist_tracks`), the signed-in user's own playlists, other members' explicitly public playlists, and synchronized public server/member playlists from permitted peers. Private playlists belonging to others are never listed. Server playlist IDs use a new `sv:` prefix to distinguish them from member playlists and remote IDs.
- **Usable song counts and entries:** Song counts are calculated from resolved, currently accessible WASP tracks instead of being hard-coded as zero. Borrowed songs in member and server playlists are resolved through `peer_track_refs` to authorized origin + remote track ID. Remote playlists resolve `track_sources` when available. Unavailable, unshared and untrusted tracks are not claimed playable.
- **Music folders:** OpenSubsonic `getMusicFolders` exposes a virtual combined WASP library, local music, and source-specific folders for peers whose music is available in the synchronized catalogue. `getMusicDirectory` can browse source → artist → album → track; `getIndexes`, `getArtists`, search, and album list accept `musicFolderId`. These are virtual groupings, not real filesystem directories. **Some Android apps require Navidrome-specific behavior for their Folders UI**, which cannot be guaranteed by standard Subsonic endpoints alone.
- **8-character codes:** New device credentials use cryptographically random A–Z and 0–9 characters, exactly eight characters. Preexisting 16-character or older longer credentials remain valid and revocable. The button reveals the code once in a centered bold pill, with a copy icon and clipboard-success message.
- **Security:** An 8-character base36 code provides approximately **41.4 bits of entropy**, notably less than the previous 16-character credentials. For this staging design, the server persists and enforces 12 failed authentication attempts per 15-minute window, scoped by username (or client network address for key-only authentication). Authentication throttling does not make short codes equivalent to long, high-entropy tokens. Use HTTPS and revoke exposed device keys. WASP-managed server encryption is unchanged; no secret needs to be reconfigured.

## Supported P2P scope

The mobile adapter uses the same existing v16 federation snapshots as v16.0.2: music on the v16 installation, direct configured/synced WASP peers, and public HTTPS downstream sources explicitly registered by an approved v15 gateway (one hop). Private network addresses, unshared sources, and disconnected or unsynchronized sources cannot be discovered automatically. Peer audio continues to be fetched from the allowed source's `/audio/{id}` using byte-range streaming; browser cookies and mobile keys are **never forwarded to peers**.

## Upgrade test process

1. Back up v16 staging D1/R2 and pin your currently deployed v16.0.2 Git commit. Do not apply this incremental patch to v15.0.9 or the live `KNDPZ/WASP` installation.
2. Apply **v16.0.3 upgrade patch to the existing v16.0.2 staging repo** (or deploy the complete v16.0.3 package in a new isolated test environment). Rebuild/redeploy both the Worker and static assets. Preserve existing bindings and storage.
3. Verify Admin version **16.0.3**, Mobile Bridge enabled, encryption ready, and the existing per-device keys still work. Do not reset the master secret.
4. Under Admin → Network → Connected Peers, re-sync your approved v15 gateway and check the Tracks / Playlists / Users / Federation sync results. Remember that peer snapshots, not the bridge UI itself, determine which downstream music is available.
5. On Android, reconnect or refresh the library. Verify `getPlaylists` contains server, member, and peer playlists; open them to check playable entries, counts and search. Try a track available only on a peer, seek within it, and verify the source does not receive device credentials. Test Folders and note any app-specific Navidrome limitation.
6. Generate a fresh 8-character key in Account Settings → Mobile, test the centered copy button and confirmation, and verify that an old key still works until revoked. Rotate any previously exposed individual mobile key (without resetting the server-wide secret).
7. Validate the native WASP web player, P2P connections and public Request page have not changed. Test rollback by redeploying your pinned v16.0.2 commit while preserving databases/volumes.

## Known limitations and production gate

- Real Android Subsonic clients vary in their support for nonstandard virtual folder trees. In particular, the user's screenshot shows a client saying its Folders view requires Navidrome; this release cannot guarantee it will enable that client-specific feature.
- Folders cannot expose an origin if that origin is not trusted, not synchronized, or has no accessible tracks. Not every public peer necessarily provides all playlist/track metadata.
- **Do not promote to production solely from automated tests.** First validate with your actual v15 gateway, two or more peer-only tracks, at least one server, member, and peer playlist, mobile seek/range support, authentication rate limits and backup/rollback plan.
- Code and migration changes are additive. The Mobile Bridge uses a new table `mobile_auth_limits` for authentication throttling; existing music and playlists are not rewritten.

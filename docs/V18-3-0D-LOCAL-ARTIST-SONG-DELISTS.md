# WASP v18.3.0d — Local Artist & Song Delists

**Exact upgrade baseline: v18.3.0c.** This release is *only* the requested Delists feature. It replaces the previously drafted but undeployed v18.3.0d legal/consent build; neither the public Legal Center nor publishing consent from that separate unreleased build is included. Merge those later if desired.

## Administrator workflow

Open **Admin → Danger → Delists**. (The existing destructive **Clean database** tool is still accessible in the adjacent subtab.)

- **Artist**: enter the artist name; songs credited to that artist are marked unavailable even if other performers are credited on the same recording.
- **Song**: enter the song title and artist name. Only matching recordings with both title and artist are restricted. A similarly titled song by a different artist stays available.
- Rules are reversible: click **Restore playback** beside the rule. This does not alter source files or connected HIVE peers.
- **Keep delisted artists and songs discoverable in search** is **ON by default**. Turn it off to remove restricted artists/songs from WASP browser search results without erasing their underlying catalogue records; album/artist/song browsing still shows unavailable tracks.
- Rule storage is server-local in the additive `delist_rules` D1 table; the search preference is a normal setting. No centralized cross-peer policy is pushed, and no record is removed.

## Runtime behavior

- Local and peer song cards remain visible with grayed-out/unavailable styling; the user cannot play them from cards, a release, a playlist, radio, or a restored queue. When a new rule arrives, an active restricted track is paused.
- Audio restrictions are enforced **server-side** on `/audio/<id>` including byte-range and HEAD, and on the Docker read-only music-folder gateway and authenticated same-origin peer-audio relay. The internal gateway check uses the installation's existing `SCANNER_SECRET` and fails closed on an unavailable policy service.
- **Subsonic/mobile clients** cannot show WASP's unavailable-row styling; restricted songs are omitted from those clients' catalogues, playlists and search, and playback is blocked. The shared mobile catalogue cache is not mutated by the restriction filter.
- Other songs from the same peer continue to work. The peer domain is not disconnected or deleted.
- **Telemetry** and historical plays, metadata records, reactions and source-catalogue synchronization remain untouched; HIVE-wide listening analytics still include data received from connected peers, including restricted artist/song names.

## Scope and limitations

- Delisting controls **this WASP instance**, including its playback and relays. It does not take remote music offline, force another independent operator to remove it, prevent somebody navigating directly to the remote server, or guarantee legal immunity against infringement claims.
- Matching uses normalized artist credits and song title/artist tags. Variants of a recording's title, spelling and incomplete metadata may require additional rules or corrections. A delisted artist must be explicitly included in a track's artist credits for the artist rule to match.
- Worker/Docker integration was verified locally with automated fixtures and browser UI checks, not with real production Cloudflare D1, Portainer, Tailscale or peer hosts.
- Keep persistent Cloudflare bindings, Docker volumes and `/music` mounts intact. A rollback to the older build will make these rules **unenforced**, even if the additive table still exists. Do not roll back during an active takedown unless a different enforcement method is in place.

## Verification after deploying to Test

1. Delist a test artist with two songs and a guest appearance. Confirm all three still appear but are unavailable; a different artist on the same album remains playable.
2. Delist one song; confirm unrelated songs, including a similarly titled song by another artist, remain playable.
3. Try direct audio URLs, a peer relay and (if installed) Subsonic playback. Restricted requests should be rejected.
4. Toggle search discoverability. Browse and telemetry should remain intact.
5. Remove both rules and confirm local playback is restored. Repeat on Docker staging before promoting to Main.

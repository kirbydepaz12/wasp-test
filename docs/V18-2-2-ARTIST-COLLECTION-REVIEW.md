# WASP v18.2.2 — Artist Photo Refinements & Reviewable Album/Playlist Assembly

**Upgrade baseline:** exact v18.2.1 source. No MP3 rewriting, no deletion of existing tracks, and no destructive D1 migration.

## Artist header

- Clicking an uncovered artist hero photo opens the original full-size image. The redundant expand icon is gone.
- The lightbox has no X button; click outside the photo or press Escape to dismiss. Focus the artist photo and press Enter/Space for keyboard access.
- Local-server and HIVE-peer source symbols are displayed alongside the available-song/release count, not beside the large artist name.
- Lineup and Similar Artist cards have a stronger translucent background, borders and hover contrast to remain legible over photographs.
- The existing full lineup and Similar Artists **Show more** interaction are preserved; responsive tests include 19 lineup members and 24 similar artists.

## Admin Add Music: reference search and assembly

**Admin → Add music → Album / Playlist** now uses the same credential-free *album search source* used by public album requests (Deezer metadata). Search results drop down while the administrator types. This does **not** mean the results are supplied by Spotify. For exact public Spotify album or playlist links, the app can try to read the public embed track list using the already implemented playlist recreation approach. Embed access may fail or return only a partial list; incomplete references are flagged, never silently treated as complete. A Spotify developer app or credentials in Requests are not required for these new paths.

Selecting a collection creates or resumes an administrator-only **D1 assembly draft**. A playlist draft also creates its corresponding playlist (or requires confirmation to reuse an existing one) so available approved songs are playable before the collection is complete. The draft records source slots, matched track IDs, source completeness and its playlist ID. It can be reopened under **Pending album / playlist assemblies**.

The workflow:

1. Select the reference album/playlist from dropdown or paste its public Spotify link.
2. Select local MP3 files. WASP reads their local tags to suggest one file for a source slot only when song title and artist agree. Suggestions are *not* automatic approval.
3. Each reference track can be manually assigned an MP3 filename or an existing WASP track. A confirmed existing track reuses its stored audio; albums retain each track's credited artist.
4. Missing tracks can generate individual Requests from the admin panel.
5. Files that aren't assigned to reference slots appear in **Unrecognized files**. Default: **Exclude (do not upload)**. The administrator may instead choose **Keep as separate song**. To include one in a release, select that file explicitly in the matching source slot. Excluding affects only the pending upload; it never deletes the MP3 from the PC or any existing WASP storage.
6. Click **Review and upload approved MP3s**. Exact SHA-256 duplicates are not reuploaded. Approved tracks are attached to their source slots; a failed upload or matching operation remains visible for review and retry.
7. The draft stays **Pending** while any known source slots remain unmatched. For a source marked partial, even matching all exposed entries requires an explicit administrator verification before marking the draft complete.

An additive `admin_collection_drafts` table stores these records. Album reassignment uses the existing `album_attach_history` to enable Undo; undoing an album attachment also reopens its saved source slot as pending. Artist credits, playlist membership, track IDs and all existing audio are preserved.

## Caveats and operational limits

- Catalogues from Deezer or public Spotify embeds may differ, omit tracks or be unavailable. Never assume the source result is the exact, complete canonical Spotify release. The public embed may stop exposing song lists without warning.
- A manually approved track association **does not retag an uploaded MP3's embedded artist or title**; approved release affiliation is stored in WASP metadata. Existing credited artist information is preserved.
- Confirmed existing tracks are local to the receiving WASP server. Peer-only audio isn't copied by this feature.
- The existing exact-byte duplicate rule remains. Retagging MP3s in Picard can change their full-file hash, and a different hash alone cannot prove the music is not already in the library.
- The draft's missing song list is based on **exposed source entries**, not a guarantee of all Spotify tracks. You may manually finalize a partial source only after independent verification.
- This is a reviewed, metadata-only guidance workflow. WASP does not download copyrighted Spotify/Deezer audio.
- Cloudflare Worker, Docker and npm behavior must still be validated live. Automated tests use mocked external catalogue fixtures.

## Verification

Backend tests cover unauthenticated admin isolation, credential-free lookups, multi-artist assignments, no music-file writes, duplicate slot protection, persistent drafts, partial-catalogue safety and explicit source verification. Chromium regression tests cover artist hero/lightbox on desktop/tablet/mobile, large lineups, Similar Artists Show more, and reviewed Add Music controls on desktop/mobile. No production deployments were performed.

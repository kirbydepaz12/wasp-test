# WASP v18.2.2a — Album Hearts, Stars and Release Navigation

**Upgrade baseline:** exact v18.2.2 source.

## New album-level reactions

An album has its own **Heart** toggle and five-star rating. These are distinct from track hearts/stars and from artist/playlist reactions. Album controls appear alongside **Play release** in an expanded Artist discography release and in the List display, and on the full album page. The votes are stored in the existing `entity_reactions` and `star_votes` D1 tables, so no destructive schema change or MP3 rewrite is needed.

The album identity is normalized by release name and the grouped release artist (including *Various Artists* for multi-artist compilations). This prevents unrelated generic releases from being aggregated when they are grouped as distinct albums; it does **not** claim external canonical release IDs, and an album whose grouping changes substantially after retagging may receive a new voting identity. Nothing transfers votes from an older grouping automatically.

Votes on locally available albums are validated against existing track album metadata. Peer-only albums require an explicitly registered peer origin. No votes are posted to a remote server. Existing playlist, artist and track reaction behavior remains unchanged.

## Rankings

Both `/#hearts` and `/#stars` now show the subtabs **Songs / Albums / Artists / Playlists**, in that order. Albums with positive album-level votes appear under **Albums**; hearts are sorted by album-heart counts and stars by the sum of album-star votes (with average and vote count displayed). These are **album-level votes**, not inferred totals from the individual songs. Albums that are no longer in the current playable catalogue are not rendered.

## Album navigation in the playback queue

When Up Next represents a **Release**, its release name is now a clickable link. WASP prefers the currently playing track's credited artist for the destination URL, then opens the matching shared release with all locally available contributing performers, including soundtrack compilations. The audio player and queue are not recreated just for navigation; the link is not shown when the current playing track cannot be linked reliably to the release.

The album name at the top of an expanded Artist discography also links to the corresponding album page, scoped to the selected artist where possible. Generic titles continue to use the existing separate release grouping.

## Caveats

- Ratings are held by the current WASP deployment. They do not automatically synchronize across peers.
- Album hearts/stars do not retroactively inherit individual track reactions.
- An album's identity is based on the grouped catalogue metadata currently in WASP; tag corrections or large changes to its grouping may alter its identity. Empty or invalid identities are never accepted.
- Up Next release navigation requires the current song to belong to a recognized release. Arbitrary radio queues are unaffected.
- No automatic audio reupload, album reassignment, D1 reset or new administrator credential is necessary.

## Deployment validation

Deploy to Test first. Verify album hearts and stars on a single-artist album and on a multi-artist compilation; refresh and confirm saved votes. Check Albums in Most Hearted / Most Starred, including most/least sorting. Play a compilation from one contributor's artist page and click the Up Next release name: all contributors should remain listed on the album. Confirm the queue and audio continue playing. Verify the original lineup and Similar Artists Show more still work. Then promote to Docker and Main if the tests pass.

RSS is **not** part of v18.2.2a; it remains a separate follow-up after user specifies scope.

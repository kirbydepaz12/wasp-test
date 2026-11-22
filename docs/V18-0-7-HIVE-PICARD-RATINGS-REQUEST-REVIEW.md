# WASP v18.0.7 — Picard metadata, HIVE ratings and request review

Built on the exact v18.0.6 HIVE Radio UI baseline. **This is a staging release; do not treat synthetic browser or SQLite tests as production certification.** Preserve Docker volumes, R2 objects and D1/local database snapshots before upgrading. No existing audio file is rewritten or deleted by the features below.

## Embedded metadata, using actual MusicBrainz Picard MP3 samples

WASP's bounded MP3 tag reader and browser upload reader now extract more of the existing ID3v2 fields:

- Main release date (`TDRC`, year or `YYYY-MM-DD`), original release (`TDOR`, `TXXX:originaldate`/`originalyear`) and original-year-first classification for **Music by Decade**. Remasters retain both dates rather than conflating the edition with the original release.
- Credited artist list (`TXXX:ARTISTS`) and aligned MusicBrainz artist UUIDs (`TXXX:MusicBrainz Artist Id`). A collaborator is not silently merged with the main artist.
- Genre (`TCON`), title, album and track number; preserved embedded artwork continues to use the existing artwork path.
- Explicit artist-country codes (`TXXX:artistcountry`) and begin area (`TXXX:artistbeginarea`) when present. Never infer artist origin from `MusicBrainz Album Release Country` (`XW` means worldwide market).
- Timestamped text inside `USLT` is recognized as *timed lyrics metadata*, distinct from a proper `SYLT` frame; this version does **not** introduce a karaoke lyrics renderer.
- Embedded `POPM` ratings are recognized for metadata inspection, but the new *WASP vote* system stays independent; uploading a file cannot submit a listener's vote.

The two real supplied files were tested separately (without bundling copyrighted MP3 files): *Angel of My Dreams* (JADE) and *AFRAID TO DIE* (P.O.D. feat. Tatiana Shmayluk). Both include original release dates, genre, artwork, MusicBrainz artist IDs and timestamped `USLT`; neither includes an explicit artist-origin country or `POPM`. Their release-country value is a market, not origin.

Docker upgrades perform one durable read-only backfill pass on existing web-uploaded MP3 objects, even if year/genre were already populated. Unchanged folder files are tracked by the persistent incremental index with tag-reader versioning. Verified country values are shareable through the existing trusted metadata feed. For artists with a MusicBrainz ID but no country tag, the Docker offline index can disambiguate matching artist identities where the database contains the matching ID; it will not invent a country if lookup is ambiguous or absent.

## Public HIVE Radio genre paging and Up Next

- Compact selectable genre pills (no visible checkboxes), colored lime when active; selections remain active across pages and appear as individually removable chips.
- Dot indicators navigate horizontal *pages* of 24 genres; no tall scrollbar. Responsive desktop/mobile layouts.
- In Up Next, a playlist name is clickable and navigates to the existing playlist route when its source ID is known.
- Ephemeral Radio queues, song limits, guest access and account-save flow are unchanged.

## Hearts + five-star WASP ratings

- Existing hearts stay available.
- Track, artist and playlist reaction controls show five star positions; clicking a star records a 1–5 score for that visitor or account, clicking the same star again clears their vote.
- Both server aggregates and the visitor's own rating are returned. Source-specific peer identifiers prevent accidental cross-server mixing.
- Thumbs and the Most Liked / Most Disliked public navigation items are hidden. Legacy reactions remain **stored**, so no historical reaction data is destroyed.
- The provided `star.png` is included as decorative artwork. New ratings **do not** backfill existing thumbs votes or import a Picard `POPM` rating as a site-wide vote.

## Admin → Network → Telemetry & Metadata

Four subtabs organize the same saved settings: **Offline Metadata**, **Online Metadata**, **Telemetry**, **Others**. The global Save settings action stays visible regardless of active subtab. Offline matching requires a complete Docker index; online lookup has a separate explicit action. Telemetry contains PULL/PUSH explanation and links to the existing Crons controls. All existing provider credentials remain server-side.

## Requested Spotify playlist review

An admin can inspect missing Spotify entries, scan fuzzy *suggestions* from the local/peer catalogues and manually search tracks. Suggestions are never automatically accepted. The red **❌** rejects a candidate and the green **✅** explicitly confirms the match. Source selection is validated server-side before being saved. Song entries may also be added, temporarily removed (and restored), or marked as done with explicit warnings when some songs are unavailable or Spotify supplied only a partial list. The list of known missing songs survives in the completed request metadata; the created playlist contains only matched entries.

This feature manages the **local WASP's playlist requests**. A remote HIVE request still belongs to its originating peer and cannot be rewritten or force-completed from another server. Local completion does not delete any original MP3.

## Staging checks

```bash
npm test
python tests/ui_v18_0_7_review.py
python tests/ui_v18_0_7_radio_stars.py
python tests/ui_v18_0_6_radio_layout.py
python tests/ui_v18_0_4_offline.py
```

For a live test server, confirm D1 migration, R2 tag reads, the Docker file backfill, trusted peer exchange, account permissions, Spotify embed completeness, playlists with 100+ entries and Up Next navigation. Full production-scale MusicBrainz downloads and real Cloudflare/Docker execution are not included in these isolated tests.

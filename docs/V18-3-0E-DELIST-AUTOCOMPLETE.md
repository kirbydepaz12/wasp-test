# WASP v18.3.0e — Delists Autocomplete & Per-Rule Search Visibility

**Exact base: v18.3.0d Local Artist & Song Delists**. No destructive migration or media changes.

- **Admin → Danger → Delists** now suggests artist names and titles using local tracks and saved, approved HIVE peer snapshots. Suggestions require 2 characters and are administrator-only. Selecting a song also fills its artist credit. You can still type a name manually; confirmation of suggestions is not mandatory.
- A **Hide from search** checkbox is **unchecked by default for each new delist**. Whether or not it is checked, that delist blocks music playback on this WASP instance. When checked, the matching artist/track is omitted from global song/artist/album searches, including homepage search. Browsing directly in artist/album pages and historical HIVE telemetry remain unchanged.
- Existing delists remain in force. On first use, the older global search preference is migrated into the per-rule flags, so previously hidden delists stay hidden. Existing rule flags can be edited in the Active delists list. The old `/api/admin/delists/searchable` endpoint is retained only for compatibility and updates all existing rules.
- The dropdown is rendered in WASP's dark theme with keyboard navigation and responsive layout. New inputs are not required to match the catalogue exactly; manually entered spellings must still match the metadata credits for enforcement.
- The server stores only an additive `hide_search` column on the existing `delist_rules` table. Songs and peer domains are not deleted or unlinked. Local media endpoints, Docker folder gateway, peer relay, and Subsonic restrictions remain enforced even with search visibility off.

## Validation

Deploy to Test first. Delist an artist from the suggestion list, leave the search checkbox off, then verify it is still searchable but cannot play. Enable Hide from search for that rule and search for the exact artist title: no matching entries should appear. Confirm the artist's biography and HIVE telemetry remain visible via direct navigation. Recheck song-level rules, peer sources, restored audio, and Subsonic playback. Existing independent peer hosts are not modified by this release.

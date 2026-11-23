# WASP v18.1.4 — HIVE Daily Plays Heatmap

The **Across the HIVE** card on the `/#top/telemetry` page is now a GitHub-style contribution calendar for **confirmed plays**. Each small square is one calendar day; no plays are near-black, while increasing play counts appear in four green shades using the WASP lime palette. The design matches the existing dark panels and keeps the adjacent **Days of the week** bar chart unchanged.

## Behavior

- **Last year:** rolling **365 calendar days including today**. **Year:** view the full year selected in the main telemetry year picker. Months are across the top, weekdays run top-to-bottom (Sunday through Saturday), and the newest dates are on the right. Off-range padding is invisible.
- **Day detail:** hover a cell or focus it with a keyboard to see the local calendar date and exact number of plays. Zero-play days are displayed as near-black. Levels: 0, 1–2, 3–5, 6–10 and 11+ confirmed plays. The legend reads **Less → More**.
- **Scope:** the existing **Entire HIVE** / **This server** selector controls the heatmap too. Federated event IDs are already deduplicated on import (`origin_id,event_id` unique), so forwarded events are not counted twice. The response never exposes listener identities or audio files.
- **Timezone:** days use the browser's minute offset, matching existing telemetry aggregation. (Like existing WASP summaries, it is a single offset for the requested period; historical DST transitions are not independently recalculated.)
- **Mobile:** the card stays on the page, and its daily squares scroll horizontally rather than shrinking to unreadable pixels. The heatmap is inside the already separated, lazy-loaded telemetry iframe and does not remount or interrupt audio playback.

## Resource use / compatibility

New read-only endpoint: `GET /api/telemetry/heatmap?scope=hive|local&range=rolling|year&year=YYYY&offset=minutes`. Uses **one indexed, bounded daily COUNT SQL query**, with existing `telemetry_summary_cache` for up to five minutes on Cloudflare or one minute on Docker. No D1 migration, no music hashing, no R2 storage changes, no peer network polling, and no writing of playback metadata. `GET /api/telemetry` remains backward compatible.

If telemetry cannot be loaded, the heatmap card explains the error instead of displaying fabricated zero activity. Historical coverage remains limited to confirmed events retained since WASP v17 and partial migrated history; older months may legitimately appear dark.

## Upgrade and validation

- **Base:** exact v18.1.3a full source for the incremental patch. For other versions use the complete source after backup and staging tests.
- **Version:** `v18.1.4 · HIVE Daily Plays Heatmap`, visible in the admin version label.
- Run `npm test`, the new `tests/ui_v18_1_4_daily_heatmap.py` browser scenarios and selected legacy telemetry/player regressions. No real production Cloudflare/Docker deploy has been performed by packaging.
- Preserve your Docker volumes, D1 bindings, R2 objects, and authentication data; never use `docker compose down -v`.

**ONE HIVE. EVERY BEAT.**

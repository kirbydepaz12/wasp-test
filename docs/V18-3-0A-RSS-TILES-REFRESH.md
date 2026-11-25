# WASP v18.3.0a — RSS Titles, Four-Column Tiles and Refresh

**Upgrade baseline:** exact WASP v18.3.0. All earlier RSS tabs, feed URLs, embeddings, and ON/OFF settings remain saved. No destructive schema migration or audio operation occurs.

## Homepage RSS display

- The fixed, oversized **RSS** heading has been removed.
- Administrators can optionally set an **RSS section title** in Admin → General settings → RSS, e.g. *News*, *Announcements*, *Music*, or leave it blank for no heading. This title is independent of each feed tab's label.
- The Home RSS container uses neutral charcoal, matching the main webapp rather than a green tint.
- RSS items render in an image-forward **four-column grid** on desktop. Tablets use two columns, and narrow mobile screens use one column. Cards show headline, publication date, and shortened summary, linking to the source when available.
- The server extracts HTTPS image URLs from RSS image enclosures, Media RSS tags, and images embedded in descriptions/`content:encoded` when possible. Not all publishers supply an image. SVG and image-less entries get a neutral placeholder. External images are loaded from the publisher; visitors can disclose their IP to that publisher, but `referrerpolicy=no-referrer` is set.

## Refresh controls and caching

- Home now has a **Refresh feed** button for the selected feed tab. A public refresh may bypass the normal cache if the last publisher fetch was at least 60 seconds ago. Excess clicks during the cooldown return the latest stored results without issuing another publisher request.
- The normal D1 feed cache lifetime is reduced from **10 minutes to 2 minutes**. Ordinary browser refreshes use the saved result until then.
- Admin → RSS Tab Editor has **Refresh published feed now** for existing saved RSS feed tabs. This bypasses the ordinary feed TTL, with a 10-second per-tab cooldown. The action is administrator-only. It also updates the saved feed cache for the public homepage. Save new or edited feed URLs before forcing a published refresh.
- RSS configuration data (`/api/rss`) is returned with no-store headers and bypasses the former shared cache, so saved section titles and tab names do not wait on a separate configuration TTL.
- If the source fails, WASP may display the last successfully cached articles with a stale indicator; this does not mean an upstream article was updated successfully.

## Security and limits

RSS/Atom fetching remains server-side, restricted to public HTTPS hostnames, bounded by size and timeout limits. Publisher HTML is not executed in the WASP DOM. Existing script-disabled embeds remain isolated. Only administrator sessions can force the published feed beyond the public cooldown. The cache and refresh policy reduce repeated fetches but cannot guarantee an external publisher has released new content, that it publishes images, or that Cloudflare Free CPU quotas will be sufficient for every third-party feed.

The RSS area still appears only when enabled below Playlists on Home. Disabling RSS preserves all saved tabs and content. Existing music playback, playlist recreation, listening telemetry, and the persistent queue are untouched.

## Suggested verification

1. Open Admin → General settings → RSS. Set the section title to **Music News**, save, and inspect the live homepage; then leave the title blank and verify no oversized RSS heading appears.
2. Confirm four articles per row on a desktop viewport, two on a medium viewport, and one on a phone.
3. Verify `media:thumbnail`, `<enclosure type="image/...">`, and embedded article images show when available, with a graceful image-less fallback.
4. Use **Refresh feed** on Home; the server enforces a public 60-second interval. Use **Refresh published feed now** in Admin to update the cache with a shorter authenticated cooldown. Confirm a refreshed Home page uses the updated results.
5. Toggle RSS OFF and ON and verify all saved tab entries survive. Play music while switching RSS tabs; the player should remain mounted.

Live Cloudflare, Docker, and third-party feed behavior have not been tested in production; stage first. Preserve Cloudflare D1/R2 bindings and Docker volumes; never reset the music library to apply this patch.

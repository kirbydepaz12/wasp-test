# WASP v18.3.0b — Seamless RSS Hover Cards

**Baseline:** v18.3.0a.

## Home RSS appearance

- The RSS section below Home → Playlists now has **no container background, border, corner, or padding**. Existing optional section title, feed tabs, refresh controls and position styles remain intact.
- RSS article cards use transparent backgrounds and transparent (layout-preserving) borders by default. On pointer hover or when a link inside the card receives keyboard focus, the card displays a subtle neutral charcoal background and an outlined border.
- RSS article thumbnails, titles, date and summaries remain visible at rest; only the surrounding card surface/outline is hidden. The image placeholder has no colored background.
- The existing four-column desktop / two-column tablet / single-column mobile grid, caching and refresh functionality are unchanged.

## Deployment

No migrations, credentials, API changes, MP3 rewrites or playlist changes. The UI remains opt-in via the pre-existing RSS master switch, which stays OFF for new installations. Existing saved feeds and titles are preserved.

Verify Home in desktop/mobile at both rest and hover or focus. Test on WASP Test before Docker or Main; existing persistent storage and Cloudflare bindings must be preserved. Live production was not modified.

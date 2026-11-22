# WASP v18.0.9 — Radio Genre Spacing & Wheel Paging

This small UI-only release is built on **v18.0.8** and changes `/#radio` genre selection without changing HIVE matching, playlists, playback, metadata, ratings or stored data.

- Remove the unintended 16px right margin inherited from the shared `fieldset label` rule. Genre pills now keep an intentional 6px gap, closely grouped without merging visually.
- Scrolling the mouse wheel vertically **or horizontally** over the genre-pill area switches one page at a time. Down/right advances; up/left returns.
- Limit rapid trackpad momentum to at most one page per 450ms, so a single scroll gesture doesn't overshoot several pages.
- Retain the clickable page dots, genre selections and removable chips across page changes. At either boundary, normal outer-page scrolling remains available.
- Keep checkbox accessibility (visually hidden, keyboard focusable); desktop and mobile continue to work.

No database migration, Docker volume change, Cloudflare binding change or new dependency is required. Deploy to Test WASP first, verify mouse-wheel and touchpad behavior, then update Main WASP. Never remove persistent Docker volumes.

## Verification

```bash
npm test
python tests/ui_v18_0_9_radio_wheel.py
python tests/ui_v18_0_7_radio_stars.py
```

Automated tests are isolated; they do not certify a live AWS/Cloudflare deployment.

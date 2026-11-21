# WASP v18.0.6 — HIVE Radio Interface Polish

This update refines the public `/#radio` form without changing how songs are selected, played, or saved.

- **Artist:** A capped, accessible list of matching artists appears **directly below the search field** instead of in a browser-controlled popup beside the search box. Search by partial name and choose with a click or with the Arrow/Enter keys. Escape dismisses suggestions. The current text entry remains available.
- **Genre:** Each checked genre appears as a chip beside the Artist / Genre / Decade / Top songs controls. Press its **×** button to uncheck and exclude that genre immediately, without resetting the form or already-generated radio.
- **Artist and Decade:** Their inputs align horizontally with **Songs in radio**, the optional **Custom number** field, and **Generate radio** on desktop. Hint text appears below its own control without shifting the other fields down. Narrow screens stack the controls.

The existing ephemeral queue, HIVE matching, 1–100 track cap, anonymous access and signed-in playlist saving remain unchanged. No database migration or persistent data changes are required.

## Testing

```bash
npm test
python tests/ui_v18_0_6_radio_layout.py
```

The browser tests run against isolated fixture data and are not a substitute for staging-server validation.

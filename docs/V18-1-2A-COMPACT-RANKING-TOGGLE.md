# WASP v18.1.2a — Compact rankings sort toggle

This small visual refinement is based on **exact v18.1.2** and affects only the public Most starred and Most hearted ranking headings. Existing vote totals, backend ranking queries, record storage, player behavior and authentication are unchanged.

- Replaced the two-option **Sort by** dropdown with a single clickable icon (`public/nav-icons/up-and-down-arrows.png`, original user-supplied asset) immediately after the heading.
- Clicking the icon toggles **Most → Least → Most**, including for Songs, Artists and Playlists on both `/#stars` and `/#hearts`.
- No separate text showing the active direction is displayed. An accessible button label announces the action; keyboard activation and focus indicators remain available.
- The same server-side ascending query is still used for least-starred rankings, rather than reversing a pre-limited list. Existing score and vote counts are unchanged.
- The UI adapts to mobile screens without moving the sort control to the far right.

No database migrations, music rewrites, Docker changes or changes to historical hearts/stars are required. Apply the upgrade patch **only** to the exact v18.1.2 baseline and validate on Test WASP before Main.

## Tests

```sh
npm test
python tests/ui_v18_1_2_admin_ops_rankings.py
```

Live AWS/Cloudflare deployment and user traffic were not exercised in the isolated test environment.

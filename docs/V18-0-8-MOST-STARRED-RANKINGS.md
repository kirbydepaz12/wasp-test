# WASP v18.0.8 — Most starred rankings and voting UI polish

This **staging update** builds on the exact v18.0.7 baseline and corrects the navigation and five-star voting presentation. It does not retag or delete any uploaded music.

## What changed

- Restores the former **Most liked** placement in the public sidebar, directly below **Most hearted**, as **Most starred** (`/#stars`). Its icon is the existing user-provided `star.png`. Legacy `/#likes` and `/#dislikes` links redirect to `/#stars` rather than showing misleading thumb counts.
- Adds **Songs**, **Artists** and **Playlists** tabs on the star-based rankings page. The page uses the existing lazy-loaded telemetry/ranking document, so opening it does not interrupt the persistent audio player.
- Rankings use **actual `star_votes` records** and sort by **total stars awarded**, then number of voters and average rating. Each card displays total stars, average rating out of five, and voter count. Voting a new score replaces a visitor's previous vote rather than creating another vote.
- The ranking API returns aggregated counts **without voter identities**. Private account playlists and unregistered peer identities are excluded from public rankings. Peer music only appears in the browser when its catalogue metadata is available locally.
- Removes the **extra decorative star image beside the five selectable stars** on song, artist and playlist voting controls. The heart and five independent clickable stars remain.
- Updates the example home-featured slider link from old thumbs-up rankings to the new star rankings.

## Storage and compatibility

This is a non-destructive UI and read-only rankings endpoint update. No existing hearts, ratings, historical likes/dislikes, playlists, audio files or telemetry are deleted or converted. The `star_votes` table added in v18.0.7 remains the source of truth. New installations return an empty ranking until the first star vote; legacy thumb votes are **not** silently counted as stars.

## Testing

Tests include public ranking order, vote replacement, legacy-reaction separation, private-playlist filtering, unregistered peer filtering, desktop and mobile navigation, artist/playlist tabs, absence of decorative voting icons, and preserved player/radio behavior. Chromium browser checks run in-memory and do not exercise production Cloudflare or AWS. Deploy to a test Worker and verify real D1/R2/peer behavior before updating production.

Keep the existing storage bindings and Docker volumes. Do not use `docker compose down -v`.

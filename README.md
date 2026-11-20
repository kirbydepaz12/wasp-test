<div align="center">
  <img src="public/wasp-mascot.png" width="150" alt="WASP mascot">
  <h1>WASP</h1>
  <p><strong>Peer-to-peer music, hosted your way. ONE HIVE. EVERY BEAT.</strong></p>
  <p><a href="https://github.com/KNDPZ/WASP">GitHub</a> · <a href="https://wasp.playy.online">WASP</a> · <a href="docs/V18-0-5-HIVE-RADIO-PLAYLIST-UX.md">Latest feature guide</a></p>
</div>

WASP is a music web app designed to join independently hosted music collections into a HIVE. A host can store songs on a Docker server or a Cloudflare Worker with R2; connected peers make eligible music discoverable and playable without copying every file between servers. WASP keeps a persistent web player, playlists, requests, reactions and federated, anonymous listening telemetry.

## Getting started

**Local development:** Install [Node.js 22](https://nodejs.org/) and run:

```bash
npm install
npm run dev
```

**Cloudflare Workers:** Create a separate staging repository or branch on [GitHub](https://github.com/), connect it to **Workers & Pages** in the [Cloudflare dashboard](https://dash.cloudflare.com/), and deploy with D1 bound as `DB` and R2 bound as `MUSIC` as configured in `wrangler.jsonc`. You can run `npm run deploy` after configuring Worker credentials and bindings. Do not point a staging deployment at your production D1/R2 resources. See the [HIVE metadata and Cloudflare guide](docs/V18-0-2-HIVE-TELEMETRY-INTELLIGENCE.md).

**Docker / Portainer:** Use [Portainer](https://www.portainer.io/) to create a stack from your WASP GitHub repository, using `docker-compose.yml`. Set `MUSIC_FOLDER` to your existing host music directory (mounted read-only as `/music`) and `UPLOAD_FOLDER` to the host uploads directory. Keep the named volumes that contain `.wrangler/state`, Caddy data and settings. HTTP and HTTPS are served by the same stack container. Docker uses local persistent state; it does not consume your Cloudflare production D1 quota. See [offline metadata setup and storage](docs/V18-0-4-HIVE-OFFLINE-METADATA-ENGINE.md).

**Critical security step:** Change the installation's default admin password immediately. Never publish a server, expose your music library or share an account until that password has been changed. Keep Spotify and metadata API secrets outside Git.

**Safe upgrades:** Back up Docker state volumes or Cloudflare D1/R2 before upgrades. Apply a changes-only patch strictly to its stated predecessor; otherwise start from the full ZIP in an isolated staging environment. Do not delete Docker volumes while updating. Verify playback, peer access, requests and existing playlists before promoting to production.

## Feature guides and linked modification references

| Area | Documentation |
|---|---|
| **v18.0.5 · Public HIVE Radio & playlist UI** | [Radio generation, top songs, metadata columns, artist credits, duplicate review, README navigation, testing](docs/V18-0-5-HIVE-RADIO-PLAYLIST-UX.md) |
| **v18.0.4 · Offline metadata engine** | [Docker MusicBrainz artist/release-group downloads, local matching, safe updates](docs/V18-0-4-HIVE-OFFLINE-METADATA-ENGINE.md) |
| **v18.0.3 · Incremental file metadata & telemetry** | [Tag backfill, persistent file index, individual Week/Month/Year/All time charts](docs/V18-0-3-HIVE-METADATA-TELEMETRY-REFINEMENT.md) |
| **v18.0.2 · Telemetry intelligence** | [Docker-first scanner, Cloudflare peer metadata pull, listening retries and HIVE request sync recovery](docs/V18-0-2-HIVE-TELEMETRY-INTELLIGENCE.md) |
| **v18.0.1 · Request and playlist recovery** | [Request origin status, missing-song search, partial Spotify playlist migration](docs/V18-0-1-HIVE-REQUEST-PLAYLIST-RECOVERY.md) |
| **v18.0.0 · HIVE Smart Routing** | [Playback failover, adaptive sources, request housekeeping, telemetry visualizations](docs/V18-0-0-HIVE-SMART-ROUTING.md) |
| **v17.0.7 · Metadata coverage** | [Release-year and artist-country progress reporting](docs/V17-0-7-HIVE-METADATA-COVERAGE.md) |
| **v17.0.6 · Metadata integration** | [Metadata integration fixes](docs/V17-0-6-METADATA-INTEGRATION-HOTFIX.md) |
| **v17.0.5 · Provider resource optimization** | [Metadata provider configuration and rate limits](docs/V17-0-5-HIVE-METADATA-RESOURCE-OPTIMIZATION.md) |
| **v17.0.4 · Spotify request completion** | [Spotify pagination and completion safeguards](docs/V17-0-4-SPOTIFY-REQUEST-COMPLETION.md) |
| **v17.0.3 · Peer sync** | [HIVE peer sync hotfix](docs/V17-0-3-HIVE-PEER-SYNC-HOTFIX.md) |
| **v17.0.2 · HIVE requests** | [Federated requests and Spotify reconstruction](docs/V17-0-2-HIVE-REQUESTS-SPOTIFY.md) |
| **v17.0.1 · Telemetry visualizations** | [Artist map, genre trends, listening clock](docs/V17-0-1-TELEMETRY-VISUAL-REFINEMENT.md) |
| **v17.0.0 · Federated HIVE Telemetry** | [Telemetry and player continuity](docs/V17-0-0-HIVE-TELEMETRY.md) |
| **v16 · Mobile Bridge** | [Mobile features and account keys](docs/V16-0-4-PLAYLIST-ARTWORK.md) · [Latest album/favorites refinements](docs/V16-0-6-MOBILE-FAVORITES-ALBUMS.md) |
| **v15 · Member and peer publishing** | [Account / community publishing](docs/V15-0-5-ACCOUNT-COMMUNITY-PUBLISH.md) · [Peer permissions](docs/V15-0-6-PUBLISHING-PERMISSIONS-NOTIFICATIONS.md) |
| **v14 · D1 optimization** | [Database and cache optimization](docs/V14-D1-OPTIMIZATION.md) |

Additional technical notes and earlier feature guides are in the [`docs/` directory](docs/). Admins can browse the same bundled documents through **Admin → Update documentations** without an external fetch.

## What HIVE Radio does

Anyone can open `/#radio`, select **Artist**, **Genre**, **Decade** or **Top songs**, and generate an ephemeral Up next queue of **20, 30, 50 or 1–100 custom songs**. A radio uses only tracks currently available from participating HIVE servers. A signed-in regular member can explicitly save that selection to a private account playlist. Anonymous visitors are invited to register; generating a radio never copies audio or creates a database playlist. Missing metadata is not guessed.

The public player's artist credit links to artist details or, for several credited artists, a comma-separated search on `/#artists`. This multi-artist search is exclusive to the Artists directory. User playlist owners can review potential duplicates, stage removals, undo them and save changes without deleting the underlying music.

## Validation

```bash
npm test
python tests/ui_v18_0_5_radio.py
```

Tests run against fixtures. Verify the actual Cloudflare Worker, Docker build, HTTP/HTTPS, peer reachability, user permissions and persistent volumes independently in staging before deploying to production.

<div align="center">
  <img src="public/wasp-mascot.png" alt="WASP mascot" width="150">
  <h1>WASP</h1>
  <p><strong>One HIVE. Every Beat.</strong></p>
  <p><strong>A self-hosted, peer-to-peer music web application.</strong></p>
  <p>
    <a href="https://github.com/KNDPZ/WASP">GitHub repository</a> ·
    <a href="https://wasp.playy.online">WASP website</a> ·
    <a href="docs/V18-1-5D-PLAYLIST-ART-ALBUM-MATCHING.md">Latest feature guide (v18.1.5d)</a>
  </p>
</div>

## What is WASP?

WASP is a **peer-to-peer music streaming web application** built around the idea that different people can host their own music libraries and connect their servers into a shared **HIVE**. A host remains in control of its own files and sharing settings; listeners can discover and play eligible tracks from connected WASP peers without having to copy each peer's entire music collection to one central server.

WASP supports music uploaded through the web app, read-only indexing of an existing music folder on a Docker host, and Cloudflare Workers with D1 and R2 storage. Features include cross-peer playback, source failover, public and personal playlists, music requests, Spotify playlist reconstruction, hearts and five-star ratings, HIVE listening telemetry, artist/album metadata, and public **HIVE Radio**. The web player stays mounted while users browse other pages.

**Current source version: v18.1.5d — Playlist Track Artwork & Album Request Matching.** See the [feature guide](docs/V18-1-5D-PLAYLIST-ART-ALBUM-MATCHING.md) or the [feature documentation links below](#feature-documentation).

## Administrator login and security warning

> [!CAUTION]
> **CHANGE THE DEFAULT ADMINISTRATOR PASSWORD IMMEDIATELY ON EVERY FRESH INSTALLATION.** The initial credentials are publicly known. Anyone who can access a server still using them may be able to take over its administrator account.
>
> **Initial admin ID:** `admin`  
> **Initial admin password:** `21232f297a57a5a743894a0e4a801fc3`  
> **Change it under:** **Admin → Account settings** after your first sign-in.
>
> **Do not expose WASP to the public internet, share your library with the HIVE, or distribute login access before changing the default password.** Use a strong, unique password and HTTPS where possible.

The credential above applies **only to a fresh database**; upgrading an existing installation does not reset an administrator password you already changed. The administrator can also change the login username in Account settings without losing the admin role. Do not commit live passwords, Spotify credentials, API keys, `.env` secrets, or persistent state to GitHub.

## Deployment options

| Deployment | Intended use | Where the music/data lives |
|---|---|---|
| **Local development** | Testing and development with Node.js and Wrangler | Local development state |
| **Cloudflare Workers** | Public or remote streaming with managed Cloudflare services | Cloudflare **D1** database and **R2** music/artwork storage |
| **Docker / Portainer** | Self-hosting on EC2, a server or a NAS | Persistent Docker state and uploads, plus an optional existing host music directory |

### 1. Local development — npm

1. Install [Node.js 22](https://nodejs.org/) (including npm).
2. Clone or download this repository and open a terminal in the directory containing `package.json`.
3. Run:

   ```bash
   npm install
   npm run dev
   ```

4. Open the local URL printed by Wrangler (typically `http://localhost:8787`).

To regenerate the bundled admin-readable documentation after editing files in `docs/`, run `npm run build:docs`. To execute the backend regression suite, use `npm test`.

**Temporary Windows Picard metadata server:** after `npm install`, run `npm run pc` (not `npm run dev`). On `http://localhost:8787/admin#collection`, specify e.g. `D:\MUSIC` and click **Scan now**. This starts a separate, read-only PC metadata feed on loopback port **8792**. Tunnel **only 8792** securely; never expose ports 8787 or 8788. [Full setup and receiving-deployment instructions](docs/V18-1-5-PC-PICARD-METADATA-SOURCE.md).

Local development does **not** automatically publish music or replace your production Cloudflare/Docker installation. Treat any local test data and admin credentials as separate from production.

### 2. Cloudflare Workers — deploy from GitHub

WASP uses [Cloudflare Workers](https://developers.cloudflare.com/workers/), [D1](https://developers.cloudflare.com/d1/) for the application database, and [R2](https://developers.cloudflare.com/r2/) for uploaded audio and artwork.

1. Fork this [WASP GitHub repository](https://github.com/KNDPZ/WASP) or publish the complete source files to your own repository. Keep `package.json`, `wrangler.jsonc`, `src/`, `public/`, `docs/` and `scripts/` in the repository.
2. Open the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** and connect your GitHub repository to a Worker deployment. Choose the correct repository branch and root directory.
3. Inspect `wrangler.jsonc` before publishing: set the intended **Worker name** and verify that the D1 binding is named `DB` and the R2 binding is named `MUSIC`. Configure/confirm the actual Cloudflare resources and required secrets for your account.
4. Use `npm run deploy` as the deploy command (it builds the bundled docs before running Wrangler), or perform the same steps from your terminal after authenticating Wrangler:

   ```bash
   npm install
   npm run deploy
   ```

5. After deployment, open the assigned Worker URL, verify the library and administrative functions, **change the default admin password**, and only then enable HIVE sharing when desired.

> [!WARNING]
> **Protect an existing production Worker.** The bundled `wrangler.jsonc` may still use a staging Worker name. Never connect an experimental branch to the production Worker or production D1/R2 resources by accident. Keep **Test WASP** and **Main WASP** separate, and back up important data before changing bindings or deploying.
>
> Cloudflare D1 has usage limits. For large-scale metadata processing, prefer the Docker-hosted offline engine and import verified facts through trusted HIVE peers where supported. [Telemetry intelligence guide](docs/V18-0-2-HIVE-TELEMETRY-INTELLIGENCE.md) · [Offline metadata guide](docs/V18-0-4-HIVE-OFFLINE-METADATA-ENGINE.md).

### 3. Docker / Portainer — self-hosting

The included `Dockerfile` and `docker-compose.yml` run WASP using **one application container serving both HTTP and HTTPS**, with Caddy and locally persisted Worker state. Docker can operate independently of Cloudflare production.

**Deploy using Portainer and a Git repository:**

1. Install [Docker](https://docs.docker.com/engine/install/) and [Portainer](https://www.portainer.io/) on your host, then open **Portainer → Stacks → Add stack**.
2. Choose **Repository** as the build method, and enter/select the URL of your WASP GitHub repository (or your own fork). Use the intended branch (such as `refs/heads/main`) and the compose path **`docker-compose.yml`**.
3. Set the required environment variables in Portainer. In particular:

   | Variable | Example | Meaning |
   |---|---|---|
   | `MUSIC_FOLDER` | `/srv/music` | Host folder containing existing music; mounted **read-only** at `/music` |
   | `UPLOAD_FOLDER` | `/srv/wasp/uploads` | Writable host folder for music uploaded through WASP |
   | `SITE_ADDRESS` | `music.example.com` | Hostname or IP that clients use for HTTPS (without `https://` or a port) |
   | `HTTP_PORT` | `18080` | Default host-side HTTP port |
   | `HTTPS_PORT` | `18443` | Default host-side HTTPS port |
   | `TLS_ARGS` | `internal` | Default Caddy internal TLS mode; configure trusted HTTPS for public hosting |

4. Deploy the stack and let Portainer build the image. By default, access it at `http://SERVER-IP:18080` or `https://SERVER-IP:18443`. If internal TLS is in use, expect a browser certificate warning until trusted TLS is configured. Ensure the host firewall/security group allows only the ports and clients you intend.
5. Sign in as administrator and **change the default password before exposing the service or sharing the library**.

For direct Docker Compose use, configure the same variables in `.env` or your host environment, then run:

```bash
docker compose up -d --build
```

**Music folder and uploads are separate.** The container indexes files from `MUSIC_FOLDER` without renaming, moving or deleting the originals. Use an **absolute path on the Docker host**, not a folder on your laptop unless it is the host. `UPLOAD_FOLDER` must be writable and persistent. You can update the folder mapping later in Portainer without changing the music files.

**Preserve your existing data:** Keep the `wasp-v16-local-state`, `wasp-v16-caddy-data` and `wasp-v16-caddy-config` named volumes, plus the upload folder and the existing music mount. These names are retained in the current Compose file for compatibility with earlier WASP installations. **Never use `docker compose down -v`** as an update step or delete Docker volumes to repair a build. A source-only update should not overwrite your production data.

**Offline MusicBrainz metadata:** Docker users can optionally download a persistent artist/release-group index under **Admin → Network → Telemetry → HIVE Offline Metadata Engine**. Ensure sufficient **free disk space** before starting: the first import involves multi-gigabyte downloads and indexing, and the installer enforces protective headroom checks. Cloudflare does not need to download that database; it can pull permitted verified metadata from a reachable Docker HIVE peer. Read the [offline metadata deployment guide](docs/V18-0-4-HIVE-OFFLINE-METADATA-ENGINE.md).

## Main features

- **Federated music:** connect eligible servers, discover local/peer tracks, handle duplicate sources, and keep playback available using HIVE Smart Routing/failover.
- **Public and user playlists:** browse, copy, customize, heart and manage playlists; owner-controlled Undo/Save and reviewable duplicate suggestions do not delete original audio.
- **Requests and Spotify playlist reconstruction:** request individual songs, artists, albums and playlists; refresh HIVE matches, check origin availability, and recover missing playlist songs later.
- **HIVE Radio (`/#radio`):** any visitor can generate a temporary queue by artist, genre, decade or all-time top songs; select 20, 30, 50 or a custom 1–100 tracks. Signed-in users may save it as a personal playlist.
- **HIVE Telemetry:** listening history, music-by-decade, artist origin, genres, top tracks/albums/artists, and individual Week/Month/Year/All time filters.
- **Metadata intelligence:** incremental embedded-tag scanning, trusted peer metadata, historical telemetry reclassification, and optional offline MusicBrainz matching on Docker.
- **Release Updates:** Admin → General settings → Release Updates monitors the public [Stable](https://github.com/KNDPZ/WASP) or [Test](https://github.com/kirbydepaz12/wasp-test) repository for new releases or commits. Forks are never updated automatically.
- **Account and admin tools:** user profile/password settings, controlled peer publishing, server-local public announcements with live preview, selective HIVE telemetry pulls and a local telemetry refresh, scheduled jobs, a protected running-process dashboard with auditable administrator actions/text export, and an in-app read-only documentation viewer.

## Feature documentation

These are **direct links to the documentation bundled with the repository**. They remain accessible in GitHub, and administrators can read them inside WASP via **Admin → Update documentations**. The source files live in [`docs/`](docs/).

### v18 — Routing, requests, telemetry, offline metadata and Radio


| Area | Guide |
|---|---|
| v18.1.5d — Playlist artwork & album request matching | [Choose individual track artwork for playlist covers; scan local and peer album candidates](docs/V18-1-5D-PLAYLIST-ART-ALBUM-MATCHING.md) |
| v18.1.5c — Request matching & individual song requests | [Local and HIVE peer potential matches for song requests, rejected recordings and separate missing playlist tracks](docs/V18-1-5C-HIVE-REQUEST-TRACK-MATCHING.md) |
| v18.1.5b — Metadata pull CPU & matching hotfix | [Worker-sized batches, resume, rematch pending Picard metadata](docs/V18-1-5B-METADATA-PULL-CPU-MATCHING-HOTFIX.md) |
| v18.1.5a — Metadata pull hotfix | [Corrected missing backend API import; improved authorized metadata source UI](docs/V18-1-5-PC-PICARD-METADATA-SOURCE.md) |
| v18.1.5 — Windows Picard metadata source and manual pull | [PC-only npm music-folder scanner, metadata feed, peer import, review, undo](docs/V18-1-5-PC-PICARD-METADATA-SOURCE.md) |
| v18.1.4 — HIVE daily plays heatmap | [WASP-native 365-day play calendar, date tooltips, HIVE/local scope, caching](docs/V18-1-4-HIVE-DAILY-PLAYS-HEATMAP.md) |
| v18.1.3a — Release Updates channel hotfix | [Test channel selection, 404 handling and optional private-repository access](docs/V18-1-3A-RELEASE-UPDATES-CHANNEL-FIX.md) |
| v18.1.3 — GitHub Release Updates | [Stable/Test channels, GitHub release and commit notifications, opt-in admin guidance](docs/V18-1-3-GITHUB-RELEASE-UPDATES.md) |
| v18.1.2a — Compact ranking sort control | [Icon toggle beside Most starred/hearted headings](docs/V18-1-2A-COMPACT-RANKING-TOGGLE.md) |
| v18.1.2 — Running processes, audit logs and ranking sort | [Process monitoring, admin audit log export/clear, compact Users table and most/least rankings](docs/V18-1-2-ADMIN-PROCESSES-LOGS-RANKING-SORT.md) |
| v18.1.1 — Public live announcements and telemetry refresh | [Anonymous and registered visitor notices, quiet ding, refresh persistence, local cache rebuild](docs/V18-1-1-PUBLIC-ANNOUNCEMENTS-TELEMETRY-REFRESH.md) |
| v18.1.0 — Server identity, selective telemetry, local announcements | [Managed peer selection, duplicate-safe listening-event import and user notices](docs/V18-1-0-SERVER-IDENTITY-TELEMETRY-ANNOUNCEMENTS.md) |
| v18.0.9 — Radio genre paging polish | [Compact genre pills and mouse-wheel page navigation](docs/V18-0-9-RADIO-GENRE-WHEEL-PAGING.md) |
| v18.0.8 — Most starred and rating polish | [Restored star-ranked charts and streamlined five-star controls](docs/V18-0-8-MOST-STARRED-RANKINGS.md) |
| v18.0.7 — Picard metadata, ratings, playlist request review | [Release dates, artist origins, five-star voting, Radio and admin refinements](docs/V18-0-7-HIVE-PICARD-RATINGS-REQUEST-REVIEW.md) |
| v18.0.6 — HIVE Radio form layout | [Centered genre selection, artist suggestions and aligned controls](docs/V18-0-6-HIVE-RADIO-UI-POLISH.md) |
| v18.0.5 — HIVE Radio and player/playlist UI | [Radio, metadata columns, multi-artist links, duplicate review and UI testing](docs/V18-0-5-HIVE-RADIO-PLAYLIST-UX.md) |
| v18.0.4 — Offline metadata engine | [Downloadable MusicBrainz index, safe updates and offline lookup](docs/V18-0-4-HIVE-OFFLINE-METADATA-ENGINE.md) |
| v18.0.3 — Metadata and telemetry refinement | [Incremental tags, persistent file index and independent chart filters](docs/V18-0-3-HIVE-METADATA-TELEMETRY-REFINEMENT.md) |
| v18.0.2 — HIVE telemetry intelligence | [Docker scanning, peer metadata pull, retries and sync recovery](docs/V18-0-2-HIVE-TELEMETRY-INTELLIGENCE.md) |
| v18.0.1 — Request and playlist recovery | [Peer request origin, missing song search and Spotify playlist recovery](docs/V18-0-1-HIVE-REQUEST-PLAYLIST-RECOVERY.md) |
| v18.0.0 — Smart Routing | [Adaptive peers, streaming failover and request housekeeping](docs/V18-0-0-HIVE-SMART-ROUTING.md) |

### v17 — HIVE Telemetry, requests and metadata

- [v17.0.7 — Metadata coverage](docs/V17-0-7-HIVE-METADATA-COVERAGE.md) · [v17.0.6 — Metadata integration fixes](docs/V17-0-6-METADATA-INTEGRATION-HOTFIX.md) · [v17.0.5 — Provider resource optimization](docs/V17-0-5-HIVE-METADATA-RESOURCE-OPTIMIZATION.md)
- [v17.0.4 — Spotify completion](docs/V17-0-4-SPOTIFY-REQUEST-COMPLETION.md) · [v17.0.3 — Peer synchronization](docs/V17-0-3-HIVE-PEER-SYNC-HOTFIX.md) · [v17.0.2 — HIVE requests and Spotify](docs/V17-0-2-HIVE-REQUESTS-SPOTIFY.md)
- [v17.0.1 — Telemetry visualization](docs/V17-0-1-TELEMETRY-VISUAL-REFINEMENT.md) · [v17.0.0 — Federated HIVE Telemetry](docs/V17-0-0-HIVE-TELEMETRY.md)

### Earlier WASP features

<details>
<summary><strong>v16 — Mobile Bridge, playlists, artwork and account features</strong></summary>

- [Mobile Bridge staging](docs/V16-0-0-MOBILE-BRIDGE-STAGING.md) · [Managed secrets](docs/V16-0-1-MOBILE-BRIDGE-MANAGED-SECRET.md) · [Mobile federation](docs/V16-0-2-MOBILE-FEDERATION.md)
- [Mobile playlists, folders and keys](docs/V16-0-3-MOBILE-PLAYLISTS-FOLDERS-KEYS.md) · [Playlist artwork](docs/V16-0-4-PLAYLIST-ARTWORK.md) · [Live presence](docs/V16-0-5-MOBILE-LIVE-PRESENCE.md) · [Album/favorites refinement](docs/V16-0-6-MOBILE-FAVORITES-ALBUMS.md)

</details>

<details>
<summary><strong>v15 — Federated library, accounts, sidebar and publishing</strong></summary>

- [Federated library](docs/V15-0-0-FEDERATED-LIBRARY.md) · [Feature completion](docs/V15-0-1-FEATURE-COMPLETION.md) · [Sidebar BBCode](docs/V15-0-2-SIDEBAR-BBCODE.md) · [Embedded artwork fallback](docs/V15-0-3-EMBEDDED-ARTWORK-FALLBACK.md)
- [Collapsible sidebar](docs/V15-0-4-COLLAPSIBLE-SIDEBAR.md) · [Accounts and community publishing](docs/V15-0-5-ACCOUNT-COMMUNITY-PUBLISH.md) · [Publishing permissions and notifications](docs/V15-0-6-PUBLISHING-PERMISSIONS-NOTIFICATIONS.md)
- [Live listening](docs/V15-0-7-LIVE-LISTENING.md) · [Account settings overlay](docs/V15-0-8-ACCOUNT-SETTINGS-OVERLAY.md) · [Currently streaming](docs/V15-0-9-CURRENTLY-STREAMING.md)

</details>

<details>
<summary><strong>v14 and v13 — HIVE groundwork, database and peer connectivity</strong></summary>

- [v14 — D1 optimization](docs/V14-D1-OPTIMIZATION.md) · [D1 SQL fix](docs/V14-0-1-D1-HOTFIX.md) · [Library refresh/crons](docs/V14-0-2-LIBRARY-REFRESH-CRONS.md) · [Peer sync and recent listening](docs/V14-0-3-PEER-SYNC-RECENT-LISTENED.md)
- [v13 — Peer relay](docs/V13-PEER-RELAY.md) · [WASP feature update](docs/V13-WASP-UPDATE.md) · [Peer reactions and Spotify](docs/V13-WASP-PEER-REACTIONS-SPOTIFY.md) · [Spotify admin settings](docs/V13-SPOTIFY-ADMIN-SETTINGS.md)
- [Similar artists and peer reactions](docs/V13-SIMILAR-PEER-REACTIONS.md) · [Peer reaction charts](docs/V13-PEER-REACTION-CHARTS.md) · [Artist/playlist ratings](docs/V13-PLAYLIST-ARTIST-RATINGS-FIX.md)

</details>

## Safe updates and testing

1. **Back up** your Docker local-state and upload volumes or your Cloudflare D1/R2 resources, as appropriate.
2. Use a **test server or staging Worker first**. Apply a changes-only patch only to the exact specified previous version; otherwise use the complete source archive.
3. For Docker/Portainer, rebuild the image and retain the existing host paths, named volumes, security settings and port mappings. For Cloudflare, verify Worker names, secrets and resource bindings before deploying.
4. Check login, audio playback (local and HIVE peers), playlists, requests, telemetry and radio. Confirm the version indicator in the admin sidebar.
5. Run source checks when developing:

   ```bash
   npm test
   python tests/ui_v18_0_5_radio.py
   ```

The browser script requires its test dependencies and environment; automated fixtures are **not** a substitute for a real Docker/Cloudflare deployment check. WASP does not automatically move or delete music files when peers disconnect or playlist entries are removed.

**Before sharing your library with others:** change the installation's default admin password, use a secure deployment, and enable HIVE sharing only when you intend to do so.

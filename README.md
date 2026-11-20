## WASP v18.0.4 — HIVE Offline Metadata Engine (staging)

Optional Docker-only MusicBrainz artist and release-group index, local factual matching before online lookups, persistent incremental cursor and existing HIVE metadata synchronization. See the [v18.0.4 setup, storage and validation guide](docs/V18-0-4-HIVE-OFFLINE-METADATA-ENGINE.md). Upgrade from exact v18.0.3.

## WASP v18.0.2 — HIVE Telemetry Intelligence (staging)

Docker-first persistent metadata scanning and progress, Cloudflare peer-only verified metadata pulls, full-year telemetry and duplicate-safe playback retries, and atomic HIVE request synchronization with legacy ledger repair. See the [v18.0.2 setup and validation guide](docs/V18-0-2-HIVE-TELEMETRY-INTELLIGENCE.md). Upgrade from exact v18.0.1.

## WASP v18.0.1 — HIVE Request & Playlist Recovery (staging)

Selected request refresh, administrator-only origin checks and temporary offline hiding, Spotify partial playlist finalization, and missing-song recovery across eligible HIVE peers. Upgrade from exact v18.0.0; see the [v18.0.1 rollout and validation guide](docs/V18-0-1-HIVE-REQUEST-PLAYLIST-RECOVERY.md).

## WASP v18.0.0 — HIVE Smart Routing (staging)

Adaptive browser audio-source selection and bounded failover, local HIVE request housekeeping, a manual peer telemetry shortcut, and interactive country and decade listening details. Existing storage, accounts and peer settings are preserved. Upgrade only from v17.0.7; review the [v18 rollout and validation guide](docs/V18-0-0-HIVE-SMART-ROUTING.md) before staging.

## WASP v17.0.7 — HIVE Metadata Coverage Enhancement (staging)

Admin → Network → Telemetry now includes release-year and artist-origin coverage percentages, classified play counts, a manual bounded scan, and configurable frequently-played priority. MusicBrainz album release groups are cached by artist and album and reused across historical tracks; optional Wikidata factual fallback fills missing fields without fabricating data. Existing metadata, credentials, peer cursors and confirmed listening history are preserved. Use the default one entity per batch on Cloudflare Free; enable scheduled enrichment and allow MusicBrainz/Wikidata fallback if Last.fm is preferred. See [v17.0.7 setup, limits and rollback](docs/V17-0-7-HIVE-METADATA-COVERAGE.md).

## WASP v17.0.4 — Spotify Request Completion Fix (staging)

This focused update fixes **HTTP 409 Conflict** when a public Spotify playlist request shows 50/50+ visible songs and the administrator selects **Mark as done**. Spotify's public embed may return 50 or 100 tracks without verifying the playlist's actual size; being at that boundary is not proof that more tracks exist. When Spotify provides a trustworthy playlist-level total, WASP distinguishes verified full lists from known truncated ones. When the source total is unverified and all retrieved songs are available, **Admin → Requests** offers **Finalize N retrieved songs…** with explicit confirmation that unseen Spotify tracks will not be included. An administrator may **not** use that override when Spotify specifically reports more tracks than WASP retrieved, or when any retrieved song is still missing.

Existing active requests, playlists, music, Docker mounts, peer links, and telemetry are preserved. Finalized-unverified requests retain an audit marker in their stored request metadata and move to Previous requests; the songs and cover are added to the administrator-managed playlist as before. API errors are shown directly instead of the misleading generic “Couldn't refresh.” User-owned private Spotify playlist reconstruction is unchanged. No database schema migration is needed. See [v17.0.4 release notes](docs/V17-0-4-SPOTIFY-REQUEST-COMPLETION.md) for deployment, testing, and caveats.

## WASP v17.0.3 — HIVE Peer Sync Redirect Hotfix (staging)

This focused upgrade fixes the **`Invalid redirect value`** error seen in Wrangler / Cloudflare Workers when v17.0.2 tries to pull telemetry and federated music requests from peers. It replaces the unsupported `redirect: 'error'` setting with supported `redirect: 'manual'`, and explicitly rejects redirect responses (including opaque/previously-followed redirects). The same fix covers Spotify peer-catalogue refresh, approved Spotify cover-image fetches and Mobile Bridge peer biography lookups. All existing peer identities, cursors, playlists, track storage, audio player and Docker volumes remain in place. **Do not delete or reset the `telemetry_peer_cursors` table**; it will resume at the saved position on the next successful poll.

No music endpoints, listening-event deduplication rules, scheduler cadence, privacy controls or Cloudflare deployment configuration were changed. This fixes application-side fetch compatibility, **not** the separate issue of a private Docker instance being unreachable from Cloudflare. The peer telemetry feed must still be reachable and sharing enabled. A HIVE dashboard summary may take up to five minutes to refresh after import. See [v17.0.3 release notes](docs/V17-0-3-HIVE-PEER-SYNC-HOTFIX.md) for validation, limitations and rollback.

## WASP v17.0.2 — HIVE Requests & Spotify Playlist Recreation (staging)

WASP v17.0.2 adds default-on five-minute HIVE telemetry sync with a separate sharing toggle, manual **Run now** controls and real progress for all Admin → Network → Crons maintenance jobs, local/cloud/both source badges on tracks and artists, origin-tagged HIVE-wide request exchange through approved peers, and local-versus-peer availability counts for requested Spotify playlists. Signed-in members can privately recreate a **public Spotify playlist** from its URL under My Playlists; available local and remote tracks are referenced, while individual missing songs become network requests. Only the playlist owner can mark a fully known import as complete; imported playlists start private and retain Spotify cover artwork when available. Existing P2P audio streaming and the persistent browser player are preserved.

**Important:** Spotify's public embed can provide incomplete metadata; the importer cannot reconstruct omitted tracks. Federation is eventually consistent, not real-time, and requires participating v17.0.2 peers. Telemetry sharing off blocks outgoing telemetry while incoming pulls continue. This is a **staging candidate**; back up DB and Docker volumes and verify with your actual HIVE before promoting. See [v17.0.2 release and test guidance](docs/V17-0-2-HIVE-REQUESTS-SPOTIFY.md).

---

## WASP v17.0.1 — Interactive HIVE Telemetry Charts (staging)

This focused visual refinement keeps the v17.0.0 federated music architecture and the persistent main-page audio player. It adds a 24-hour circular listening clock, hoverable genre stream with visible legend, numerical history tooltips, a compact artist-country heat map, and release-decade distributions using verified metadata only. Existing album/audio/peer routes are unchanged. See `docs/V17-0-1-TELEMETRY-VISUAL-REFINEMENT.md` for metadata limitations and deployment checks.

---

## WASP v17.0.0 — HIVE Telemetry & Loading Time Enhancement (staging)

WASP now includes a **website-only, federated HIVE Telemetry** page under **Most listened → Telemetry** (`/#top/telemetry`). It provides cached listening trends, historical week/month/year selection, top music, listening-clock charts, and aggregate activity across participating WASP peers. Approved admin-connected peers and approved user-published peers can synchronize deduplicated, anonymous confirmed plays without copying music or exposing personal account identifiers. Legacy peers continue to work for music, although they cannot yet provide historical telemetry. Historical backfill is partial until v17 collects sufficient new records.

**Playback stays in the original page:** `telemetry.html` is lazy-loaded alongside `index.html`, and the music player is never recreated when visiting the telemetry dashboard or the consolidated Most listened / Hearts / Likes / Dislikes charts. Account Settings stays a popup; My Playlists stays a normal view. The default **Featured Slides** sample now includes a seventh **ONE HIVE. EVERY BEAT.** slide after **Shuffle the pit**; existing custom slides remain unchanged. No Subsonic app update is required.

**Staging only:** Back up persistent D1/SQLite and music storage, apply the upgrade patch **only to v16.0.6**, then test peer federation and uninterrupted audio on your actual deployment before considering production. See the full [v17 telemetry and safety guide](docs/V17-0-0-HIVE-TELEMETRY.md).

<div align="center">
  <img src="public/wasp-mascot.png" width="170" alt="WASP yellow-and-black wasp mascot on transparent background">
  <h1>WASP</h1>
  <p><strong>Peer-to-peer music, hosted your way.</strong></p>
</div>


## WASP v16.0.6 — Album grouping and Mobile Bridge compatibility hotfix (staging)

- **Compilation and soundtrack album grouping:** On `/#recent/albums`, tracks with the same distinctive album title are grouped as one release even when credited to different performers. Generic titles such as `Greatest Hits` remain separated by artist; opening a compilation shows every track in the group.
- **Sidebar:** The sidebar remains vertically scrollable, but the browser's temporary visible scrollbar is hidden when expanding the icon rail. The sidebar divider remains intact.
- **Mobile hearts:** For signed-in WASP members, Subsonic `star`/`unstar`, `getStarred(2)`, and song `starred` metadata use the same WASP account reaction records as the native browser. Local and trusted peer songs are supported. Visitors who are not signed in retain independent anonymous browser hearts; a mobile key is scoped to its WASP user account. Old reactions are preserved. Newly shared account votes contribute to the local server's heart count, without changing upstream peer reactions.
- **Artist metadata:** Subsonic search, `getArtists`, and `getArtist` return an artwork identifier and WASP-hosted image URL. Artist info requests reuse the native Wikipedia/cache lookup; where necessary, the adapter asks up to two authorized peers for a public biography. No device credentials are sent to a peer. External biography lookups may still return no results.
- **Advertising sample:** The existing **Insert sample slider** button now inserts the agreed six-slide HIVE carousel, with **BE PART OF THE SWARM. EXPAND THE HIVE.** at slide 5 and **Shuffle the pit** at slide 6. Existing saved advertising HTML is not overwritten.
- **Unchanged:** Playlist-list artwork behavior is deliberately not modified in this release, pending inspection of the Android client's own implementation. Native P2P music, playlists, Mobile Bridge keys, audio and storage remain otherwise unchanged.

**Upgrade:** Apply the changes-only v16.0.6 patch strictly to **v16.0.5**, or deploy the full release to an isolated test environment. Back up D1/R2 or Docker persistent state; do not apply a v16.0.5+ patch directly over v15.0.9 production. Real-device validation against your Android app and remote peers remains required before production rollout. See [`docs/V16-0-6-MOBILE-FAVORITES-ALBUMS.md`](docs/V16-0-6-MOBILE-FAVORITES-ALBUMS.md).

## WASP v16.0.5 — Mobile Live Streaming Activity (staging hotfix)

Mobile playback through supported Subsonic/OpenSubsonic clients now contributes **best-effort anonymous live presence** to the existing WASP `/#listened` streaming section, including approved peer tracks. The Mobile Bridge records successful stream requests and start-scrobble signals in the current `active_streams` table; it does not create extra scrobbles or copy audio. Multiple byte-range requests from one mobile key count as only one session. There is **no database migration**.

**Compatibility limit:** Third-party clients may pause, preload entire tracks, or play offline without sending status updates. Live presence therefore expires after a bounded time and can briefly overstate or miss actual playback. WASP's native web-player presence remains more accurate because it sends explicit play/pause/stop signals. For cross-server dashboards, the mobile-hosting WASP must be reachable as an approved peer. See [`docs/V16-0-5-MOBILE-LIVE-PRESENCE.md`](docs/V16-0-5-MOBILE-LIVE-PRESENCE.md).

## WASP v16.0.4 — Mobile Bridge / Subsonic & OpenSubsonic integration

**WASP now supports connecting compatible Subsonic/OpenSubsonic mobile music players to its existing peer-to-peer music network.** An Android client has successfully authenticated to the v16 staging Mobile Bridge and displayed server playlists with real song entries. This confirms **mobile API connection and playlist browsing**; the v16.0.4 playlist-artwork fix still requires a fresh on-device test, and a successful full-network playback test remains a production-release requirement.

**This is a staging release**, intended for a separate GitHub repository and isolated Worker, D1 database, R2 bucket, or Docker stack—not an untested in-place replacement for a live v15 deployment. The native WASP web player, accounts, peer protocol, music storage, and web playlists remain the source of truth. **WASP does not install Navidrome or a second Subsonic server.** Its optional Mobile Bridge translates Subsonic/OpenSubsonic requests into native WASP operations.

### Mobile Bridge capabilities

- **Connect an Android/iOS Subsonic-compatible client** to `https://YOUR-WASP-DOMAIN/mobile` or to your staging `workers.dev` hostname with `/mobile` appended. A root `/rest/*` alias supports clients that do not preserve subdirectory URLs.
- **Browse and search music from the WASP P2P network**, including the local library, synchronized approved peers, and eligible one-hop shared public downstream peers. Audio is streamed on demand from the trusted source, not copied into a second library.
- **Access WASP server playlists, your own playlists, other members' public playlists, and synchronized public peer playlists**, including permitted remote-track entries. Other users' private playlists remain private.
- **Playlist cover art (v16.0.4 hotfix):** Subsonic `getPlaylists`/`getPlaylist` now provide a `coverArt` ID that `getCoverArt` can serve. Uploaded server/member covers are reused; a trusted peer's cover is fetched from its shared art endpoint; when no standalone cover exists, the first playable song's artwork is used. WASP's browser-only mosaic is not reproduced as a server-generated image.
- **Virtual music folders and genre browsing** where source metadata exists. Some third-party clients may require Navidrome-specific endpoints for their particular Folders UI; those features are not guaranteed.
- **Per-device mobile credentials:** Members create an independently revocable, 8-character uppercase A–Z/0–9 code under **Account Settings → Mobile**. An administrator configures the persistent installation secret and enables the bridge under **Admin → Network → Mobile Bridge**. Do not enter your normal WASP account password into a third-party player.
- **Security boundaries:** Mobile requests are authenticated; other members' private playlists are not exposed. Peer artwork/audio requests never forward the user's mobile key or browser cookies. The optional bridge can be disabled without disabling native WASP.

**Connect from a mobile player:** (1) The administrator enables Mobile Bridge and generates the WASP-managed secret under **Admin → Network → Mobile Bridge**; (2) the member creates a device key in **Account Settings → Mobile**; (3) in a Subsonic/OpenSubsonic music app, use the WASP server URL ending in `/mobile`, the WASP username, and the generated key as the password; (4) refresh albums and playlists. After this hotfix, clear/reload cached playlist artwork if the player still shows an old placeholder.

**Deployment caution:** Back up D1/R2 and Docker state, keep a known-good v15 production commit, and test mobile authentication, artwork, server and peer playlist entries, peer-only song playback and HTTP byte-range seeking on staging before promoting the release. See [Mobile Bridge integration and artwork hotfix](docs/V16-0-4-PLAYLIST-ARTWORK.md), [v16.0.3 mobile playlists/folders guide](docs/V16-0-3-MOBILE-PLAYLISTS-FOLDERS-KEYS.md), and [v16.0.2 federation guide](docs/V16-0-2-MOBILE-FEDERATION.md).

**Project:** https://github.com/KNDPZ/WASP  
**Public WASP site:** https://wasp.playy.online

---

WASP is a **peer-to-peer music webapp** that lets people host their own music libraries and connect them to other WASP-compatible servers. You can listen to music on your own server or discover music shared by connected hosts. Each host controls their own library and whether to share it over the network.

You can deploy WASP locally for development, on **Cloudflare Workers**, or on your own server using **Docker / Portainer**. For self-hosted Docker installations, music can be uploaded through the webapp or indexed from an existing folder on the host server.

> [!CAUTION]
> **CHANGE THE DEFAULT ADMIN PASSWORD IMMEDIATELY.** Every fresh installation uses a known default credential. Anyone who can reach an installation that still uses it may be able to sign in as administrator. **Do not make your library public, open it to the internet, or enable “Share this library on the network” until you have changed the password.** Use a strong, unique password.
>
> Initial admin ID: `admin`  
> Initial admin password: `21232f297a57a5a743894a0e4a801fc3`  
> Once signed in, open **Admin → Account settings** to change it.


### v15.0.5: Member account management and community publishing

Administrators can change their login username in **Admin → Account settings**, while members can change theirs under **Account settings → Account**. Members also have a **Publish** tab for contributing their own public HTTPS WASP links, but an administrator must first enable publishing for each account under **Admin → Users**. The admin Users screen shows submitted and online link counts without displaying user-submitted addresses and provides password-confirmed account deletion. Submitted links are peers only, never automatically the local/primary library. Existing administrator-managed private Bridge peers remain separate. See [`docs/V15-0-5-ACCOUNT-COMMUNITY-PUBLISH.md`](docs/V15-0-5-ACCOUNT-COMMUNITY-PUBLISH.md) for safety/privacy limitations, destructive-action precautions and staging tests.

### v15.0.4: Collapsible icon sidebar

The public WASP sidebar starts fully expanded. Use the new arrow control at the top of the sidebar navigation to tuck it into a compact icon rail, giving more horizontal room to playlists, artists and songs. The compact rail uses the supplied colored/monochrome nav icons in rounded-square frames; hover over an icon to see its tab name. All links remain accessible and clickable, and sidebar BBCode credits are simply hidden until expanded. The choice is remembered in this browser. On phones, the existing horizontal text navigation remains. No data migration is required. See [`docs/V15-0-4-COLLAPSIBLE-SIDEBAR.md`](docs/V15-0-4-COLLAPSIBLE-SIDEBAR.md).

### v15.0.3: Embedded artwork fallback

If Deezer has no match for an artist, album, or track cover, WASP tries JPEG/PNG/WebP art embedded in the original MP3 (including existing R2 uploads and Docker read-only `/music` files). Peer song cards can also try embedded artwork through the peer relay. Audio files are never modified; see `docs/V15-0-3-EMBEDDED-ARTWORK-FALLBACK.md` for supported tags and limits.

## WASP v15.0.2 — BBCode sidebar footer

The Admin **Sidebar credits and branding** editor now accepts a small, safe BBCode subset (text formatting, links, images and colors) instead of arbitrary HTML/JavaScript. A live preview is provided. On the public site, credits use a compact 11px font and stay pinned to the **bottom of the sidebar**, growing upward as lines are added. Existing saved HTML remains in settings for rollback and is safely converted for display/editing until BBCode is saved. See [`docs/V15-0-2-SIDEBAR-BBCODE.md`](docs/V15-0-2-SIDEBAR-BBCODE.md) for tag examples, limitations and deployment notes.

## WASP v15.0.1 — Feature completion / deployment verification

v15.0.1 corrects primary-peer preference when a song also exists in local storage, keeps the last synced peer metadata during transient peer failures, prunes stale SHA-256 records without touching `/music`, and repairs an already-marked-v15 database if the peer-chunk table is missing. Browser entrypoints are cache-versioned. **The ZIP does not install itself**: update the GitHub/Portainer source and rebuild Docker, and deploy the Cloudflare Worker separately. Verify the admin version label before troubleshooting a missing feature. See [`docs/V15-0-1-FEATURE-COMPLETION.md`](docs/V15-0-1-FEATURE-COMPLETION.md) for the complete nine-feature activation checklist, data precautions, and limitations.

## WASP v15 — Federated library and storage management

This version introduces an administrator-selectable **primary peer** (Admin → Network → Connected peers → Treat as local), **SHA-256 duplicate management** (Admin → Duplicate management), an optional **incremental hash cron** (Admin → Network → Crons), **text/image site branding**, configurable **sandboxed sidebar credits**, a simplified **Recently listened** display, and an admin-only **Update documentations** Markdown viewer. The Cloudflare site can present one reachable peer as its local catalogue without downloading that peer's MP3 files; it does **not** automatically migrate R2 audio or make private Tailscale endpoints reachable from Cloudflare.

The v15 additive migration first repairs the `peer_catalogue_chunks` missing-table defect affecting some existing v14.0.3 installations. **Back up D1, R2 and all Docker volumes, then test on staging before upgrading production.** Never remove application state volumes during a Portainer update. Audio in `/music` remains read-only, and duplicate deletion is manually confirmed and limited to eligible web-uploaded copies with no playlist/reaction/play references. See [`docs/V15-0-0-FEDERATED-LIBRARY.md`](docs/V15-0-0-FEDERATED-LIBRARY.md) for migration checks, implementation limits and deployment testing.

## Spotify playlist search (optional)

To enable **Request → Playlist → Search**, an administrator can open **Admin → Requests → Spotify settings** and enter their Spotify Developer **Client ID** and **Client Secret**. The password-style field is blank whenever the page loads; leave it blank when updating the Client ID to keep the previously saved secret. The saved secret is AES-GCM encrypted in the installation database, is never sent back to the browser, and is used only by the server for Spotify API access. To undo the admin configuration, select **Remove saved credentials**. If Spotify credentials are also configured as server environment variables, those continue to work when no administrator-saved credentials are present.

**Docker / Portainer:** WASP automatically uses a generated, persistent installation secret to encrypt credentials saved from the administrator page. Keep the Docker application state volume backed up and avoid changing the installation secret after saving credentials. You do not need to enter Spotify credentials into Portainer if you use the administrator page.

**Cloudflare Workers:** To securely save credentials from the administrator page, first configure a persistent, random `SPOTIFY_SETTINGS_KEY` in the Worker's **Secrets** settings. For example, an authorized operator can use `npx wrangler secret put SPOTIFY_SETTINGS_KEY`. Store the key in your password manager and **never commit it to Git**. Changing or losing this key makes previously saved Spotify credentials unreadable; an administrator can then replace the saved secret. This is a one-time encryption-key requirement, not a requirement to put the Spotify credentials into Cloudflare secrets. Alternatively, you can continue to configure `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` as Worker secrets, with no admin database storage.

**Security:** Open the administrator interface over **HTTPS** when entering credentials. Do not post your Client Secret publicly or expose it in screenshots. Spotify's API permissions, app quotas, development-mode restrictions, and rate limits still apply. The paste-link request option works even when playlist search is not configured. WASP does not download Spotify audio.

## Local development

1. Download or clone this repository.
2. Install **Node.js** and **npm** if they are not already installed.
3. Open a terminal in the project directory (the folder containing `package.json`).
4. Run:

   ```bash
   npm install
   npm run build:docs
   npm run dev
   ```

5. Open the local URL printed by Wrangler in the terminal (usually `http://localhost:8787`).

This runs the app locally for development. It does not publish your code or music to Cloudflare.

## Cloudflare Workers deployment (from GitHub)

1. Open this WASP repository on **GitHub** and click **Fork** to make your own copy in your GitHub account. If you have downloaded the project instead, upload its files to a repository in your account. Keep `package.json` and `wrangler.jsonc` at the repository root.
2. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com/). Enable **R2** for your Cloudflare account if prompted; the webapp uses **R2** for music/artwork and **D1** for library data.
3. Go to **Workers & Pages → Create application**, then choose **GitHub / Import a repository**.
4. Authorize Cloudflare to access your GitHub account and select **your fork** of WASP.
5. Configure the Worker build:
   - **Root directory:** the repository root, where `package.json` and `wrangler.jsonc` are located.
   - **Build command:** leave empty.
   - **Deploy command:** `npm run deploy` (regenerates the admin release-notes viewer before deployment).
   - **Worker name:** match the `name` in `wrangler.jsonc` (initially `musicwebapp`). If you choose a different Worker name, update that configuration before deploying.
6. Click **Save and Deploy**. After a successful deployment, open the assigned `workers.dev` URL and verify that the app loads and its R2/D1 bindings have been provisioned correctly.
7. **Immediately sign in and change the default admin password** before enabling network sharing or publicly promoting the site.

Cloudflare can redeploy the Worker when changes are pushed to the connected GitHub branch. **If you already have a live Worker, create a separate project or deliberately configure the correct Worker name before connecting a new repository; do not accidentally overwrite a production deployment.**

## Docker deployment — Portainer (recommended)

WASP can be hosted independently of Cloudflare, using Docker on a server, NAS, or other Docker-compatible host. The Docker Compose setup runs the app behind a web proxy in one container and keeps local application data in persistent Docker volumes.

### 1. Add the Git repository as a Portainer source

1. Log in to **Portainer** and select the Docker environment where you want to run WASP.
2. Open **Stacks → Add stack**.
3. Enter a stack name, for example `riffvault`.
4. Under **Build method**, select **Repository**.
5. In the **Source** dropdown, click **+ Create new source** (as shown in Portainer's repository configuration screen).
6. Fill in the **Configure Git Repository** form:
   - **Source Name:** `riffvault-github` (or any recognizable name).
   - **Repository URL:** the HTTPS URL of this repository or your own GitHub fork, such as `https://github.com/YOUR-USERNAME/YOUR-REPO`.
   - **Authentication:** off for a public repository; configure Git credentials if the repository is private.
   - **Skip TLS Verification:** leave off for GitHub.
   - **Enable polling:** optional; turn it on only if you want Portainer to check the repository for updates automatically.
7. Test/save the source if Portainer prompts you to do so.

### 2. Create and deploy the stack

1. Back on **Stacks → Add stack**, choose the newly created **Source** from the dropdown.
2. Select the Git reference `refs/heads/main` (or your actual deployment branch).
3. Set the **Compose path** to `docker-compose.yml` (relative to the repository root).
4. Before deployment, use the **Environment variables** section to set the location of your existing music folder, as explained below.
5. Click **Deploy the stack**. Portainer will retrieve the repository and build/start the Docker container.
6. By default, open `http://YOUR-SERVER-IP:8080` or `https://YOUR-SERVER-IP:8443`. Before publicly using HTTPS, set `SITE_ADDRESS` and `DEFAULT_SNI` in the Portainer stack to your actual public IP or hostname (without protocol/port). `TLS_ARGS=internal` uses an internal certificate that browsers do not automatically trust; use a trusted HTTPS hostname/certificate for production.
7. **Change the default admin password immediately**. Do not enable peer sharing or publish the server before doing so.

### 3. Map an existing folder containing music

You **do not need to upload all your songs through the browser**. WASP can read an existing folder on your Docker host, including a NAS folder already mounted on that host.

In the Portainer stack's **Environment variables**, add:

| Variable | Example value | Purpose |
| --- | --- | --- |
| `MUSIC_FOLDER` | `/mnt/storage/Music` | Absolute path to your existing music folder **on the Docker host**. |

The Compose file maps that folder into the container as `/music` **read-only**. WASP scans it and indexes its songs without moving or deleting the original files. Change `MUSIC_FOLDER` to your own path; for example:

- Linux server: `/srv/music`
- NAS mount on the Docker host: `/mnt/nas/Music`
- Synology-style path (when accessible to Docker): `/volume1/music`

**Important:** Use an **absolute path on the machine running Docker**, not a path on your laptop unless that laptop is the Docker host. Make sure the folder exists and is readable by Docker. If your music is on another device, mount that share on the Docker host first.

The Docker container also has its own persistent application storage, separate from the host music folder. Songs uploaded through the webapp are handled by the application's local storage; files in `MUSIC_FOLDER` are only read and indexed. Your Cloudflare deployment, if you have one, is separate and is not changed by deploying Docker.

To change the folder later, update the stack's `MUSIC_FOLDER` environment variable in Portainer and redeploy. **Do not delete the application's Docker volumes** when updating the stack if you want to retain its existing data.

---

**Before sharing your library with anyone:** sign in, change the default administrator password, and only then enable **Admin → Network → Share this library on the network**. Keep your server and credentials secure.

### HIVE music metadata (optional)

Under Admin → Network → Telemetry, configure Last.fm and/or MusicBrainz, choose the preferred provider, then opt in to scheduled enrichment. See [v17.0.6 credential setup and integration hotfix](docs/V17-0-6-METADATA-INTEGRATION-HOTFIX.md) and [v17.0.5 metadata setup and provider permissions](docs/V17-0-5-HIVE-METADATA-RESOURCE-OPTIMIZATION.md). Metadata is gathered incrementally; existing listening totals and music playback remain separate from the enrichment job.

### v18.0.3 metadata and telemetry refinement
See [release notes](docs/V18-0-3-HIVE-METADATA-TELEMETRY-REFINEMENT.md) for rolling date filters, incremental file-first scanning and trusted peer metadata settings.

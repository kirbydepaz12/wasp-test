# WASP v18.1.5 — Windows PC Picard Metadata Source & Manual HIVE Pull

WASP can now run a **temporary Windows npm metadata source** and let Main, Test and Docker manually retrieve corrected tag information. Only metadata crosses the network. Uploaded MP3 objects, Docker `/music` files, playlist identities, hearts, likes, stars and the HIVE play-event ledger are not replaced.

## 1. Windows PC: run the local npm server

Install Node.js 22 (with npm), extract the **complete** WASP v18.1.5 project, open **Command Prompt** in the folder containing `package.json`, then:

```cmd
npm install
npm run pc
```

Open `http://localhost:8787/admin#collection`. Sign in as the administrator, and change the default password immediately on a new local installation. A new **Local Music Metadata Source** card will appear above **Songs**, only when using `npm run pc` on the PC. It will not appear when using ordinary `npm run dev`, on Cloudflare, or on Docker.

In **Music folder location**, enter an absolute Windows path such as `D:\MUSIC`, then select **Scan now**. The scanner reads MP3 tags recursively and calculates an **MPEG-payload SHA-256** without writing to the MP3s. It displays discovered files, processed files, changed/unchanged files, errors and progress. The server keeps a private, reusable local metadata snapshot under `.wasp-pc-data/`; incremental rescans skip unchanged files by size and modification time. Scanning a new folder replaces the published snapshot, not the music files.

The PC's library is **not added** to the playable WASP catalogue. The metadata source is separate from the music library; its songs cannot be played through the metadata-only service.

### Ports and privacy

- `127.0.0.1:8787`: local admin interface (Node reverse proxy to local Wrangler at `127.0.0.1:8788`). **Do not tunnel this port.**
- `127.0.0.1:8792`: **metadata-feed-only** HTTP service, secured with a long random token. This is the **only port** to forward through a secure Cloudflare Tunnel.
- The token is generated and kept in `.wasp-pc-data/source-token.txt` (also displayed in the local terminal). Never commit or disclose it. The entire `.wasp-pc-data/` folder is gitignored.

The metadata feed does not serve MP3 audio, local paths, admin pages, sessions, artwork or music downloads. The administrative Windows folder path remains local. The feed endpoint is `GET /api/metadata-bank/feed?cursor=0&limit=25`, requires `x-wasp-metadata-token`, and pages through tagged records. Restrict tunnel access further using Cloudflare Access service tokens if possible.

**Example Cloudflare Tunnel configuration**: create a tunnel hostname of your choice, then set its private service target to `http://127.0.0.1:8792`, never `:8787` or `:8788`. A public HTTPS tunnel still requires the random metadata token. Keep the tunnel disabled when you aren't syncing.

## 2. Configure each receiving deployment

For **WASP Main**, **WASP Test**, and **Docker**, configure the metadata source explicitly in that deployment's *private server environment*:

```text
WASP_METADATA_SOURCE_URL=https://your-private-metadata-tunnel.example
WASP_METADATA_PULL_TOKEN=<token printed by npm run pc>
```

The URL is the **origin/host**, not the full `/api/metadata-bank/feed` path. The token must be at least 32 characters. Set both values as Worker environment variables/secrets in Cloudflare; on Docker/Portainer, supply them in the stack's private environment settings. Keep them out of public source code. For a Cloudflare Access-protected tunnel, also set the Worker-side/service-side variables `WASP_METADATA_ACCESS_CLIENT_ID` and `WASP_METADATA_ACCESS_CLIENT_SECRET` (secrets). Never store the raw token in a browser input or send it to an arbitrary peer.

Optional multiple authorized sources: set `WASP_METADATA_SOURCES_JSON` to a private JSON array of `{ "url": "https://...", "token": "...", "name": "..." }` objects. Only these explicit URLs appear in the selectable peer list. No URL entered by the browser can override the configured allowlist. Use HTTPS; ordinary HTTP source URLs are rejected.

Docker's `docker-compose.yml` and `docker/write-dev-vars.mjs` already forward the new environment variables to its Wrangler runtime. Rebuild Docker after adding/updating the config; do not reset volumes. Cloudflare Main and Test must be redeployed with the corresponding variables; never point a staging deploy at a production database by mistake.

## 3. Manual Pull Metadata workflow

In each receiving deployment, navigate to **Admin → Network, Metadata, Telemetry → Telemetry → Online Metadata**, just above the Last.fm and MusicBrainz preferences.

1. Select **Prepare local audio matches**. This creates stable audio-payload fingerprints from the receiving deployment's **existing** songs. Cloudflare R2 uploads are read in bounded, one-file Worker requests (max. 32 MiB per item). Docker's `/music` songs are hashed read-only by its local gateway; no audio leaves the Docker host. Missing/unsupported files are skipped for manual review. Keep the admin tab open for progress.
2. Choose the authorized PC source and click **Pull metadata from selected peers now**. WASP fetches pages (up to 25 records per request) and stores pending candidates in additive D1 tables. No track metadata is changed during this step.
3. Click **Review metadata changes**. Exact and unique audio payload matches are eligible for a deliberate Apply action. Title/artist similarity is **review-only**. Unmatched or ambiguous records require an admin to choose an existing WASP track ID and confirm its identity.
4. Select verified/confirmed records and click **Apply selected verified metadata**. Confirm with `apply metadata`. Changes are limited to the existing track's title, artist, artists list, album, track number, plus stored Picard metadata and future track-genre/year values. No files are rewritten.
5. If required, use **Undo selected metadata batch** from the batch history to restore the previous fields. Undo refuses to overwrite a track whose core fields have since changed again.

A manual pull is never a push, periodic cron, peer catalogue import, metadata overwrite without review, or executable update. Main, Test and Docker each update **only their own** hosted tracks.

## Data and limitations

- Supports MP3 files in the first release. The source reads common Picard/ID3 fields (including title, artist, album, genres, dates, track/disc numbers, composer/label/ISRC and supported MusicBrainz IDs), plus a bounded subset of nonbinary custom text tags. Embedded covers and lyrics are intentionally **not** copied.
- The payload hash excludes the leading ID3v2 tag and trailing ID3v1 tag. Additional APE/ID3 metadata padding formats and re-encoded/remastered audio may not match exactly. Those cases need human review and must not be auto-linked.
- Data may be updated in WASP without rewriting ID3 tags into an uploaded MP3. Downloading an old uploaded MP3 still returns its old embedded tags.
- Metadata stored for a local Windows file not present in Main/Test/Docker does **not** create a playable track on those deployments.
- Album genres/dates are available in `/api/tracks` for future metadata use; historical play events are preserved, not rewritten or attributed retroactively.
- An import may require many small Cloudflare Worker requests. Do not run massive automatic fingerprint backfills or pulls repeatedly on a Free D1/R2 account; test 10–20 representative tracks first and monitor Cloudflare usage.
- Source token is read-only for a metadata feed, never an administrator credential. Use HTTPS, a private tunnel and Access service tokens wherever possible.
- The local Windows runtime and live tunnel were **not** exercised against a real Windows machine or Cloudflare account during packaging. Isolated Node/SQLite and Chromium browser tests are provided. Back up all deployments before a production rollout.

## Safety and versioning

**Upgrade baseline for the patch:** exact v18.1.4 source. Additive D1 tables only. Existing music files, Docker volumes, D1 track IDs, R2 objects, playlist references, likes, stars, hearts, listens, and telemetry remain intact. Never use `docker compose down -v` on an existing installation.

**Admin version label:** `v18.1.5 · PC Picard Source & Manual Metadata Pull`.

**ONE HIVE. EVERY BEAT.**

## v18.1.5a hotfix notes

The original v18.1.5 Worker omitted the `metadataBankApi` import in `src/index.js`. The authenticated endpoint therefore returned a server error even with correctly configured metadata sources. v18.1.5a imports the API correctly and includes a regression test for an authenticated administrator's `/api/admin/metadata-bank/sources` request.

The source list now shows named, selectable cards and a Select all sources control, and it distinguishes server errors from missing configuration. **Ordinary Connected peers are not automatically registered as metadata sources.** Add the Windows metadata-only HTTPS feed URL and matching read-only token to each receiving deployment's private environment first; configure any additional sources only if they implement the supported feed protocol.

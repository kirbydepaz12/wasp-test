# WASP v15.0.5 — Accounts and Community Publishing

## New features

- **Admin → Account settings:** The administrator can change the administrator *username* after entering the current administrator password. Administrator authorization remains tied to the immutable `admin` role in the server-side session, not to the new display/login name. The password and role remain unchanged.
- **Public site → Account settings → Account:** Signed-in members may change their own username with their current password. Account ID, existing playlists, reactions, and sessions are preserved. Names must be 3–32 letters, numbers, underscores or hyphens; names are unique ignoring case, and the administrator name remains reserved.
- **Public site → Account settings → Publish:** A signed-in member can list or remove their own WASP peer links if publishing is enabled by an administrator. The permission is **off by default**. Links are never automatically promoted to *Treat as local*; only an entry expressly added by the administrator under **Admin → Network → Connected peers** can become the primary/local source. The same URL, if later added by an administrator, takes precedence in peer discovery.
- **Admin → Users:** Each account shows a publishing checkbox, number of submitted links and the number last found online; user-submitted URL addresses are not included in this admin page/API response or the administrator's managed-peer list. The admin can delete a member from the far right of the row, after entering the current admin password and the exact word `delete`.

## Link validation and safety

User-published links must be **public HTTPS hostnames on port 443** (not IP literals, private/Tailscale/local names, HTTP, paths, usernames or custom ports). The server checks DNS A/AAAA records through Cloudflare DNS-over-HTTPS before performing a bounded `/api/peer` probe. The probe has a 6-second timeout, disallows redirects, rejects excessive responses and requires an affirmative WASP peer response with a valid track count. Each member may submit up to eight links. A peer must have sharing enabled on its source WASP server. These restrictions are not applied to the administrator's pre-existing Tailscale or Docker peer entries.

**Network security:** Domain DNS can change between the DNS check and the outbound HTTPS request, so network-level outbound restrictions and egress filtering are recommended for publicly accessible Docker installations. The Cloudflare DNS-over-HTTPS service must be reachable for user link verification. These network integrations have not yet been tested against a live deployment.

**Link privacy limit:** The administrator Users table intentionally exposes *only counts*, not URL addresses. However, public peer playback requires the clients to learn the remote server's origin (through `/api/network/peers` and browser requests). This means a technical administrator—or any client inspecting network traffic—can still discover public contributed peer URLs. Complete secrecy would require a trusted playback relay/proxy and a different architecture.

**Online state:** Links are validated when submitted. Their health is refreshed during Users-page checks (up to eight per load) and the existing peer-check cron when enabled (up to eight per scheduled run). Offline peers are omitted from active public peer discovery and from **Online links** counts after the next successful health check. **Provided links** counts include retained offline records. The online count describes the last completed check, not a continuous connection.

## Deleting an account

The action requires an existing administrator session, the correct administrator password and exact `delete` confirmation. It removes the member's login, active sessions, user playlists and covers, copied track references in those playlists, recorded signed-in reactions, attributable legacy voter data, submitted peer links and publishing permission. It **does not delete** shared R2 music, files in `/music`, other users' playlists, or the administrator account. The removal of relational account data uses a D1 batch; playlist cover deletion is best-effort.

**Historical attribution limitation:** Older anonymous hearts, likes, song requests, play counts or visitor-token reactions cannot always be associated with a registered account retroactively. v15.0.5 records attribution for new authenticated reactions and submissions so their corresponding records can be removed if the account is deleted. Likewise, if several accounts have shared the same browser visitor token, the system preserves any aggregate reaction shared by another surviving account instead of wrongly deleting that account's contribution. The software does not pretend that old unattributed or shared interactions were fully removed.

## Data migration and deployment

An additive migration advances `wasp_schema_version` to `15.2` and creates only new tables/indexes: `user_peer_permissions`, `user_published_peers`, and `user_voter_tokens`. It does not reset existing tracks, playlists, peer snapshots or R2 objects. All existing users begin with publishing disabled. The administrator's existing username setting is preserved.

Back up Cloudflare D1/R2 and Docker data volumes before deploying, then stage the new source against a copy of an existing v15.0.4 database. Update Cloudflare and Docker separately as required; a ZIP alone does not deploy either instance. Do not replace or remove any existing Docker volumes. Existing Tailscale Bridge peers remain configured under the administrator's Network page.

Verify that the admin version indicator reads `WASP v15.0.5` and test:
1. User registration and login; user cannot reach admin endpoints.
2. Admin and user username changes retain the correct roles and existing account data.
3. New user publishing remains disabled until explicitly approved.
4. Public HTTPS WASP link publishes and appears as a **peer**; admin still chooses any primary peer independently.
5. Online-link counts exclude last-checked-offline entries and the admin Users page does not show link URLs.
6. Incorrect password or confirmation blocks deletion; correct pair deletes the member's linked data without affecting MP3 files or the admin login.

## Verification scope

Backend tests include the migration, role-safe username changes, publication permissions, URL safety, active peer precedence, online/offline counting, and guarded deletion. Browser tests exercise the actual settings and Users UI. A live Docker build, actual DNS/HTTPS federation, and AWS/Cloudflare production upgrade are **not** verified by these local tests.

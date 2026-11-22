# WASP v18.1.3a — Release Updates channel and GitHub 404 hotfix

This is a narrowly scoped, **notification-only** repair for v18.1.3. Forked deployments remain independent. No Git pull, auto-update, Docker restart, Cloudflare redeploy, playlist change, music deletion or database schema migration is performed by the update checker.

## Fixed

- Selecting **Test · Preview** immediately changes the displayed **Upstream repository** to `kirbydepaz12/wasp-test`. It also clears the previous channel's upstream release/commit details to avoid showing misleading Stable results.
- **Save channel** persists the choice on the current WASP server. **Check now** saves the selected choice first when it has not been saved, then checks the selected channel.
- If a GitHub request fails, the page preserves and displays the channel returned by the API, including the selected repository, rather than leaving stale Stable values visible. It displays upstream release/commit as unavailable and keeps the running version visible.
- Slow or stale responses from an earlier channel can no longer overwrite a newly selected channel.
- GitHub HTTP 404 now explains that the repository may be inaccessible or private. This is not proof the repository is missing: GitHub also returns 404 for private repositories without appropriate credentials.
- Optional private-repository access via a **server-side** read-only fine-grained GitHub token; never place the token in the browser, source code or public repository.

## Private Test channel configuration

If `kirbydepaz12/wasp-test` is private, generate a GitHub fine-grained Personal Access Token scoped **only to that repository** with the minimum read-only permissions necessary for GitHub Releases and commits (Contents: read; Metadata: read). Never publish or commit the token.

- **Docker / Portainer:** set `GITHUB_UPDATES_TOKEN` in the private environment/stack settings for that installation, then rebuild/redeploy the container to apply the environment change. `.env.example` and `docker-compose.yml` document the optional variable. Do not commit a real `.env` file. The container writes it to its private Wrangler `.dev.vars` file (`0600`) at startup.
- **Cloudflare Workers:** configure a Worker secret named `GITHUB_UPDATES_TOKEN` on the **specific WASP deployment** using the Cloudflare dashboard or `npx wrangler secret put GITHUB_UPDATES_TOKEN` with the correct Worker selected. Do not set it as a public client-side variable. Cloudflare and Docker each need their own secret if both run a private Test checker.
- **Public repository:** no token is needed; first confirm the configured URL and the server's network access. A bad/renamed URL or inaccessible repository still requires correcting visibility/name or permissions. The application does **not** change these fixed upstream URLs.

**Security:** The backend sends the token only in GitHub REST requests. It is not returned to the admin page, written into release notifications or provided to peers. The per-instance channel choice remains in the existing local database `settings` table.

## Upgrade compatibility

- Incremental patch requires the **exact v18.1.3 full source**. Otherwise use the full v18.1.3a source.
- No destructive migrations or changes to D1/R2 data, playlists, Docker volumes, server folders, credentials, existing login, or audio playback.
- New build label is `v18.1.3a · Release Updates Channel Hotfix`, visible only on the admin page.
- GitHub polling is still server-cached; channel selection does not install or deploy anything.

## Validation

Run `npm test` and `python tests/ui_v18_1_3a_release_channels.py`, plus the existing `python tests/ui_v18_1_3_release_updates.py`. Automated fixtures test the 404/private behavior; actual access to private GitHub repositories must be checked in the relevant live installation.

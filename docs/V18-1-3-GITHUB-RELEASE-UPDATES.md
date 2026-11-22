# WASP v18.1.3 — GitHub Release Updates

Release Updates is an **administrator-only**, **notification-only** GitHub checker. It never pulls source into a running server, redeploys Cloudflare Workers, rebuilds Docker, changes your Git remote, resets the database, or modifies music files. It is safe for independent forks: upstream commits do **not** automatically change the fork's code.

## Configure

1. Go to **Admin → General settings → Release Updates**.
2. Choose which upstream repository this *individual WASP instance* should follow:
   - **Stable/Main:** https://github.com/KNDPZ/WASP
   - **Test/Preview:** https://github.com/kirbydepaz12/wasp-test
3. Click **Save channel**. This selection is saved in this server's existing settings database, independently of any HIVE peers and independently of other forks/deployments.
4. Click **Check now** for a manual upstream check. The sidebar also checks automatically when the administrator visits and approximately every six hours while the admin page is open.
5. When a new release/commit is available, the sidebar displays a notice above the **actual running WASP version**. Click **See what's new** or **View commit** to inspect GitHub. **Dismiss** hides only that update, in the current browser, until a different release/commit appears.

If there is a newer published GitHub Release, the notice links to the release and its notes. **GitHub Releases are optional**: new commits on the selected repository's default branch can also trigger notices. Stable ignores prerelease entries; Test can show them. GitHub API calls are bounded and cached for six hours on the Worker instance; manual checks have a minimum one-minute refresh interval to avoid rate limits. One instance's preference does not propagate through HIVE.

## Deployed-build identification and accuracy

The checker compares the **installed WASP source version** with the latest release. It can also compare the exact deployed Git SHA when provided:

- Cloudflare Workers Builds: `npm run deploy` executes `npm run build:docs`, which also writes `src/build-commit.js` using the build-time `WORKERS_CI_COMMIT_SHA` variable if available (or Git HEAD in a checked-out repository). **Check the Cloudflare Git integration/build command** to ensure this script runs before `wrangler deploy`. No GitHub token is needed for public repository checks.
- Docker/Portainer: the optional `WASP_BUILD_SHA` Compose environment value can hold the 40-character SHA of the **commit used for this deployment**. It is passed to the local Wrangler runtime. If you don't know it, leave it blank.
- Other deployments: set a valid runtime `WASP_BUILD_SHA` if your deployment system provides it.

**When an exact deployed SHA is unavailable:** on the first successful check, WASP records the latest observed HEAD commit of the selected upstream repository as a *per-channel baseline* in its settings. **Subsequent upstream commits** trigger a notification. This intentionally avoids a spurious "new commit" notice on first use of a fork, but cannot retroactively identify commits published before that baseline. A new release with a greater version still triggers a notice immediately. If the deployed SHA is unknown, a code update with no version bump cannot be proven installed, so an alert might remain until dismissed or until a manual baseline reset. Changing repositories resets neither the installed version nor your music.

SHA differences alone do not establish that a commit is newer when a fork has diverged from upstream. If your fork has an unrelated commit, compare it on GitHub before changing the deployment. Documentation-only commits can also trigger commit notices.

## Limitations and safety

- The interface cannot install or deploy updates. Changes to your fork or server always require **your own separate approval and deployment workflow**.
- GitHub must be reachable, and its unauthenticated REST API has rate limits; outages are displayed without breaking WASP music playback.
- Neither GitHub credentials nor the contents of administrator forms are sent to GitHub. Only public, fixed GitHub API endpoints are queried by the server. Admin releases status/settings are not exposed as public HIVE endpoints.
- The feature uses the existing settings table; no new database tables, migrations or music rewrites are required.
- Use the exact v18.1.2a source for the patch. Test on a staging Cloudflare Worker or Docker installation first. An isolated automated test is not equivalent to production verification.

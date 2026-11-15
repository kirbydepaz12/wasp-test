# WASP v15.0.6 — Publishing Permissions, User Table & Notifications

A focused, additive update to **v15.0.5**, with no change to music-file storage, server-folder mounting, R2 audio objects, or existing admin-managed/Tailscale peers.

## Admin → Users

- New **Allow all registered users, including new accounts, to publish** checkbox, **off by default**. This is a site-wide **default**, not a forced override. Individual permissions always take priority; an administrator can uncheck a user's **Can publish** box to deny that account even when the global default is enabled. Existing explicitly granted/denied permissions are preserved when the global checkbox changes.
- A **Search username** field filters the Users table in the browser; the request only fetches the accounts with the existing admin-only API.
- New **Dislike songs** and **Registered date** columns. Column order is Username, Heart songs, Like songs, Dislike songs, Private playlists, Published playlists, Provided links, Online links, Registered date, Can publish, Actions.
- The first click on a column header sorts ascending (A–Z, low–high, earliest–latest, unchecked–checked). Clicking the same header again reverses the order. **Actions** is not sortable. Sorting and searching operate on the accounts already loaded. A page refresh reloads current counts.
- An administrator sees a red numbered notification badge next to **Users** whenever users have pending publish requests. Pending requests appear as red dots next to the corresponding usernames. Checking that user's publishing permission approves the request and clears the pending indicators.
- The **Delete user** button retains the previous administrator-password and exact `delete` double confirmation and now also cleans up outstanding publish requests and approval notices.

## Account settings and Publish requests

- The username fields in **Admin → Account settings** and **Public site → Account settings → Account** use the existing dark, rounded input style.
- Users who cannot publish see a **Request to Publish** button below the existing explanation. Each account can have only one pending request; repeat submissions are idempotent. After requesting, the page shows an awaiting-approval message instead of another button.
- The administrator's approval creates a red notification dot next to the user's **Account settings** navigation tab and the **Publish** subtab; when the public sidebar is collapsed the dot is drawn on the top-right of the account icon. Notices are cleared **when the user opens the Publish tab**. Background checks for notifications do not clear them.
- The administrator's outstanding-request count is checked about every 30 seconds while the admin page is open. The public app checks approval status at the same interval while visible and the user is signed in, as well as during account navigation.
- **Contributed links always stay peers**. Only administrator-added managed peers can be marked *Treat as local*. The existing public HTTPS-only URL validation and peer health rules remain unchanged.

## Data migration and safety

The existing `wasp_schema_version` marker moves from **15.2** to **15.3**. Migration only creates two new small tables (`user_publish_requests` and `user_publish_approval_notices`); the global checkbox is a new `settings` entry and defaults to off if missing. Existing v14/v15 repair paths and the `peer_catalogue_chunks` schema repair remain intact. No audio files, existing user accounts, playlists, votes, MP3 tags, Docker volumes, or R2 objects are reset or rewritten.

Pending requests and permission notices are private, session-authenticated data. Only administrators may read the pending-request count and the registered-user table. The Admin Users API still omits user-submitted peer URLs; client-side federation still exposes active public peer origins to clients as explained in the previous release notes.

## Deployment

**Changes-only patch**: apply only on top of an unchanged **v15.0.5** checkout, keeping the repository's directory structure. The complete v15.0.6 ZIP is an alternative for a fresh source tree. Back up the production D1 database, R2 objects and persistent Docker volumes, stage the update against an existing v15.0.5 database, then rebuild Docker and deploy Cloudflare from the correct commit. Don't delete any persistent volumes.

Verify **Admin → version** reads `WASP v15.0.6`. Test: a new account inherits the global setting; an explicit per-account denial prevails; a denied account requests access; an admin sees a red badge, grants the request and sees it disappear; the user receives notification dots which disappear after opening Publish. Check username/date/count sorting both ways, text filtering, unchanged delete-user confirmation, and public-peer-only behavior of submitted links.

## Verification scope

Backend tests cover the v15.2-to-v15.3 additive migration, default inheritance, per-user overrides, admin-only permissions, pending-request/approval lifecycle, user acknowledgement, and community-peer classification. Browser tests cover sort/search controls, theme, admin and user badges (including compact icon mode), and the request workflow. No live Docker/Tailscale/Cloudflare deployment is performed as part of this source release.

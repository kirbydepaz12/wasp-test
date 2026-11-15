# WASP v15.0.8 — Account Settings without leaving the music

Incremental update to **WASP v15.0.7**. No changes to the music library, D1 tables, uploads, Docker folders, sessions, peer APIs or live-listening heartbeats.

## Account Settings is now a modal

- Clicking **Account settings** in the full/compact navigation or account dropdown opens an accessible native HTML `<dialog>`. The current search, music tiles, playlist, scroll position, current track, play queue and live playback stay mounted behind it.
- The UI is stored separately in `public/account-settings.html`, which the existing app fetches as a same-origin HTML template and injects into the dialog without an iframe, page refresh or new tab.
- Two tabs: **Account** (change username with password, change password) and **Publish** (request publishing permission, add peer URL, see status, remove your links). Existing user APIs and permissions are unchanged.
- The previous red publishing-approval notification badge stays attached to Account Settings in both expanded and compact sidebars; the Publish tab shows a badge until opened.
- Close using **X**, **Escape**, or the backdrop; reopening retrieves current account information without altering playback.
- `/#settings`, `/#settings/account`, and `/#settings/publish` legacy links are intercepted and display the modal, retaining the last music-browsing route; new clicks do not change the URL fragment at all.
- **Request** remains its own public sidebar destination `/#request`, including visitors who are not signed in. Request is NOT included in Account Settings.
- Administrator account settings remain in the existing `/admin.html#account` management interface. The popup provides an explicit link instead of automatically navigating away.
- `public/users.html` retains legacy playlist deep-links with the same overlay-capable `app.js` asset version.

## Install

For existing v15.0.7 installations, back up the application and copy the files from the **v15.0.8 upgrade patch** over the matching paths, *without deleting other files*. Redeploy/rebuild the frontend assets and Worker/Docker application. Reload the browser (the asset query-string cache-bust version is 15.0.8).

For fresh installs, use the full v15.0.8 archive. The release does **not** require manual database migrations and does not delete existing tracks, users, playlists, listening history, or requests.

## Verification

- `python tests/ui_v15_0_8_account_modal.py`: overlay, route/scroll stability, playback not paused/reloaded, username/password API, Publish controls and notices, guest public Request.
- `python tests/ui_v15_0_7_recent_live.py`: relative timestamps, anonymous streaming indicator, public Request.
- `node --test tests/v15_0_5_accounts_publishing.test.mjs tests/v15_0_6_publish_notifications.test.mjs tests/v15_0_7_recent_live.test.mjs`: pre-existing backend regression tests.

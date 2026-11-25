# WASP v18.3.0c — Docker Music Folders, RSS Pinned Tabs & Player Polish

**Upgrade baseline:** v18.3.0b. **No destructive database migration.** The update preserves existing tracks, uploads, playlists, RSS subscriptions, music metadata, queues and Docker state.

## Docker / Portainer: multiple music directories

Docker users now have **Admin → Music collection → Music Folders**. The subtab is displayed only when the running instance exposes the authenticated Docker folder API. Cloudflare Workers and the Windows metadata-only npm server do not expose it.

1. In **Portainer → Containers → WASP → Volumes** or your Stack compose configuration, map **an existing host directory** to a **new container location** such as `/music2`, `/music3`, `/mnt/music2`, or `/media/music2`. Set the mount **read-only**. For example, host `/data/extra-music` → container `/music2`.
2. Redeploy the container/stack so the new bind mount appears **inside the container**, preserving the original `/music`, `/data/uploads`, `.wrangler/state`, and Caddy volumes. **Never run `docker compose down -v`.**
3. Sign in as an administrator. Go to **Music collection → Music Folders**, type `/music2`, and click **Add folder**.
4. WASP verifies that the directory exists, is readable, resolves without symlinks, and is an actual container mount point; it then saves the additional scan root to `/app/.wrangler/state/music-folders.json` inside the existing persistent state volume. A folder scan starts or follows the next scheduled scanner cycle.
5. Browse **Music collection → Songs** after scanning. Indexed files are streamed from their mounted folder, never moved, renamed, or deleted by this process.

**The webapp cannot create Docker mounts or access arbitrary host paths.** Extra root registration requires an already mounted path, not a bare Windows or EC2 host path. Accepted paths are `/music*`, `/mnt/music*`, and `/media/music*`. The default `/music` is permanent. A folder may be unregistered from future scans without deleting source files or removing its Docker mount.

**Caution on removing a mount:** existing track records may remain indexed even after a path is unregistered or its host mount is removed; those songs can stop playing. Keep your original mounts intact while validating new ones. The feature does not automatically purge missing tracks or modify existing database records.

## RSS tab appearance and organization

In **Admin → General settings → RSS → RSS Tab Editor**:

- **Show titles** is checked by default. Checked tabs display their names, plus a custom image icon if configured. Unchecking hides text from the tab and displays only a thumbnail, like a pinned browser tab; the full name appears on hover and keyboard focus. Screen readers receive the full label.
- Each RSS tab has an optional **Icon image URL** field. A public HTTPS image URL can be used; the app defaults to its own `wasp-icon.png` if there is no custom icon and titles are hidden. No arbitrary scripts are executed.
- A tab has a draggable handle **⠿**. Drag it to another position; alternatively use the up/down arrows, which also work when native drag events or touch input are unavailable. Click **Save RSS settings and tabs** to persist the new ordering.
- **Public HTTPS feed URL or static embed code** is now a compact, single-line-height field matching the title input. **Expand editor** still opens a larger field for longer static embeds.
- RSS retains its master ON/OFF switch, section heading, tab alignment, image tiles, hover-only article highlights, refreshed publisher cache, and script-disabled static embeds. Turning RSS off preserves saved feed definitions, icons, tab order, and title visibility settings.

## Player control

The player bar's add-to-playlist control is now an icon matching the neighboring playback controls rather than an oversized text plus sign. Its existing click behavior and sign-in flow remain unchanged.

## Security, limitations and verification

Only authenticated WASP administrators may update Docker folder settings. The Worker talks to the local Docker gateway over loopback using the installation's private scanner secret. Cloudflare production cannot register server music paths. The Docker folder registry uses atomic file replacement in the existing persistent volume and contains paths only (no credentials). Validate the additional mount from Portainer before using the UI.

RSS icon URLs must be public HTTPS and are validated before storage; they are rendered only as `<img>` elements. Image hosting may still refuse requests, block hotlinking, or remove icons. The fallback for an absent custom icon is WASP's icon, not a third-party hostname.

**Deployment order:** Test → Docker staging → Main. Browser/regression tests do not substitute for real Portainer mount verification, a live scanner run on your EC2 host, or Cloudflare/Docker production validation.

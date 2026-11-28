# WASP v18.3.0f — 10-Minute Announcement Expiration Hotfix

This changes the *server-local* public announcement system only. Announcements expire exactly 10 minutes (600,000 ms) after the server records `created_at`, regardless of when a visitor loads the website, logs in, dismisses the popup or refreshes.

- The anonymous `/api/announcements` feed includes only unexpired records. It does not publish a 30-day backlog anymore.
- The older signed-in `/api/user/announcements` feed applies the same expiration.
- The admin Announcements history lists active announcements only. Older rows are deleted on admin history fetch, on posting, and during the existing five-minute maintenance tick (Cloudflare scheduled handler and Docker internal tick). Announcements are local to the posting instance; peers aren't affected.
- Browser notices and their queue ignore expired messages even if a stale response is received, and an already visible popup disappears at its original expiration time (up to 30 seconds maximum display as before).
- The Cloudflare edge cache key is versioned so pre-upgrade 30-day payloads are not reused. Edge cache lifetime shortens near the earliest expiration instead of holding a stale message.
- No schema migration, new environment variables, R2 changes, audio changes, playlist changes, or user/account modifications. Existing local dismissal and sound preferences remain intact.

## Upgrade

Use the v18.3.0f complete source ZIP, or apply the v18.3.0f changes-only ZIP **only over the exact v18.3.0e** source. Deploy to Test first, then Main and Docker, preserving database bindings and Docker volumes. Do not clear or recreate D1/SQLite, R2, or music. The build displays `v18.3.0f` in the admin sidebar. Verify a newly posted message appears and that a record older than 10 minutes is absent from guest/legacy/admin feeds.

## Caveats

A visitor with an already-open *old* v18.3.0e JavaScript bundle might retain the visible popup for its existing 30-second lifetime. A page reload picks up the v18.3.0f browser-side expiry enforcement. Worker-edge caching remains near-live (normally two seconds) and is time-bounded near expiry.

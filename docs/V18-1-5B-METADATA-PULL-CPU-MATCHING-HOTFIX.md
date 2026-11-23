# WASP v18.1.5b — Metadata Pull CPU Optimization & Staged Rematching

This is a narrowly scoped hotfix on **exact v18.1.5a**. It addresses Cloudflare Test's verified **Worker exceeded CPU time limit** while posting `/api/admin/metadata-bank/pull`, and adds a **Rematch staged metadata** workflow for Docker's existing pending Picard records. It does not fetch or replace MP3 audio during pull/rematch.

## What changed

- **Bounded Cloudflare pulls:** the metadata feed page limit is **2 records per HTTP request** for Cloudflare/other Worker runtimes, rather than 25. Docker continues using a bounded 25-record limit. Callers can request **1 record** if an individual Worker request is resource-limited; the admin UI retries at 1 record after a 503/resource-limit error. This lowers per-invocation CPU work but is **not a guarantee** that every Cloudflare account/plan will accept it.
- **Resume from existing staged records:** a new admin-only `GET /api/admin/metadata-bank/pull/progress?source=...` derives a checkpoint from the highest source sequence already staged in the existing database. Reopening the browser after a stopped pull continues from the checkpoint, avoiding a full repeat of the previous records. An optional **Recheck entire source catalogue** checkbox bypasses the checkpoint if the PC source has been rebuilt/reindexed. Old staged records remain intact.
- **Rematch without repulling:** `POST /api/admin/metadata-bank/rematch` rechecks pending records against **currently available local audio fingerprints** in small bounded pages. This is useful if the metadata was pulled *before* fingerprints were prepared. It works on Docker as well as Cloudflare. It does not contact the PC, edit tracks or audio, or modify playlists.
- **Matching safety:** unique exact MPEG-payload hashes can become eligible for manual Apply. Approximate title/artist matches remain **review only**. Ambiguous duplicates remain ambiguous. Explicitly manually matched, applied, or previously rolled-back entries are not silently overwritten by rematching.
- **Admin controls:** new **Rematch staged metadata** button beside Prepare local audio matches, automatic rematching after fingerprint preparation, and actionable progress messages. An administrator still must select and deliberately apply verified records.

## Suggested upgrade and recovery procedure

1. Back up the Test D1 database and Docker's persistent state before deploying. Preserve the existing `.wasp-pc-data/` snapshot and source token on the Windows PC. The patch is for **exact v18.1.5a** only.
2. **Test Cloudflare:** deploy v18.1.5b; open Admin → Network, Metadata, Telemetry → Telemetry → Online Metadata. Confirm the PC source is listed. Click **Pull metadata from selected peers now**. WASP will start at the highest staged sequence and use two-record Worker pulls (with a one-record fallback for 503). Keep the browser tab open and monitor Worker logs; an interrupted pull can be restarted without dropping staged data. Select **Recheck entire source catalogue** only if a source was rebuilt or you intentionally want a complete repeat.
3. **Docker:** deploy v18.1.5b while preserving volumes, then open the same admin page. Click **Prepare local audio matches** if not yet complete, or **Rematch staged metadata** to recheck the existing pending Picard entries. Do **not** press Pull again merely to rematch. Open **Review metadata changes** and confirm the exact-match count. Only unique exact hashes can be selected for direct Apply; manually review uncertain recordings.
4. If exact matches remain zero, look for skipped/unavailable local audio fingerprints, audio encoding differences, ID3 variants, or songs that are actually hosted only on a different deployment. This hotfix cannot make non-identical audio byte streams match. Do not bulk-assign guessed track IDs.
5. After Test and Docker are verified, update Main independently. Never connect Test to production D1/R2 bindings by mistake.

## Compatibility and guardrails

- **No database table migrations or D1 resets.** Reuses `pc_metadata_pending`, `pc_metadata_audio_hashes`, `tracks`, and the existing settings/undo tables.
- **No MP3 upload, replacement, rename, or deletion.** No playlist/plays/hearts modifications during pulling, rematching or fingerprinting.
- Applied changes still require an explicit administrator action and can be undone through existing batch-history functionality.
- The PC metadata-only HTTPS tunnel still targets port **8792**, not the local admin interface on 8787. The same token and source URLs are used; no new environment variables are required.
- The existing 3,802 pending records in Docker should remain available. They are not merged with or deleted from the library merely by deploying this release.
- Full audio fingerprint generation for cloud-hosted tracks may itself have resource limitations; this hotfix focuses on **metadata pull** CPU usage and **rematching existing** fingerprints. Live Cloudflare limits can differ by account and configuration.

## Validation

- Node/SQLite backend regression suite including dedicated incremental pull, resume, rematch, ambiguity and authorisation tests.
- Mocked Chromium admin interactions at 1440px and 390px for PC and non-PC modes.
- Package integrity and exact patch reconstruction verification.
- **Not live-deployment certified:** no real Cloudflare Worker, PC tunnel, persistent Docker database or live AWS host was exercised in these automated tests.

**Version:** `v18.1.5b · Metadata Pull CPU & Matching Hotfix`.

**ONE HIVE. EVERY BEAT.**

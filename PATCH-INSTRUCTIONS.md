# WASP v17.0.1 — Changes-only upgrade patch

Apply only to the complete **WASP v17.0.0** source repository. Unzip these files over the repository root (not into another nested folder). The patch preserves files not listed in PATCH-MANIFEST.json. Keep existing database, R2 storage, Docker volume mounts, secrets, user accounts and peer registry unchanged. Do not delete persistent data volumes.

Suggested process: back up staging D1/Docker state, commit current Git revision, extract, inspect changes, commit and deploy to staging. On rollback, restore code at the saved v17.0.0 revision; database additions are additive, but restoring data requires the backup. Verify `/#top/telemetry` and active playback before production consideration.

Included: source changes, `public/telemetry-world.json` public-domain local map geometry, new backend tests, a new UI test, and release documentation. No live servers are modified by this ZIP.

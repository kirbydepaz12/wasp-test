# WASP v17.0.0 — staging upgrade from v16.0.6 ONLY

This is a changes-only patch. **Do not apply it to any version other than exactly v16.0.6.**

1. Back up your staging installation's database, uploads, peer settings, mobile encryption key and Docker volumes. Pin the current Git revision.
2. Extract/copy the contents of this patch over the matching v16.0.6 staging repository root; preserve all files not included in this patch.
3. Commit/push to the **staging branch/repository**, not your production v15 repo. Let Cloudflare deploy with the same bindings, or rebuild in Portainer while preserving existing volume mounts. Never use `down -v`.
4. Verify admin version v17.0.0. With a song playing, visit `/#top/telemetry`, `/#hearts`, `/#likes`, `/#dislikes`, and back. It must remain the same playing track.
5. Enable sharing only on peer servers you intend to expose music/listening trends from. Test v17-to-v17 peer sync and historical pages; old peers are skipped for telemetry.
6. See docs/V17-0-0-HIVE-TELEMETRY.md for limits, privacy, migration, rollback, and full test checklist.

No running WASP service or database has been modified simply by creating these files.

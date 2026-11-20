# WASP v18.0.3 — HIVE Metadata & Telemetry Refinement

- Telemetry opens on Week, with 7 rolling calendar days, 30 rolling days, 12 monthly buckets for the selected year and monthly history from the earliest retained play for All time. Empty buckets are preserved.
- Nine telemetry tiles have independent time filters. Changing the top-level range resets tile overrides. Identical requests share cached results.
- Docker scans stored tags and existing uploaded MP3 tags before online enrichment. Folder scans retain an atomic local index of file size and modification time on the existing state volume. Normal discovery still enumerates file names and stats; unchanged files are not parsed again. Full file rescan is opt-in.
- Exact embedded facts can be shared with explicitly trusted admin peers. Consistent album release-year tags can classify missing historical plays; conflicting albums are not inferred. Embedded facts represent file tags, not independently verified release dates.
- Docker optionally reads bounded MP3 tag byte ranges from trusted admin peers. Peers that do not support valid ranges are skipped; the whole song is not downloaded. Enable in Admin → Network → Telemetry, save settings, start scanner.
- Separate local file preparation and online scan status, retry counters, provider-specific error names and cooldown countdown. Docker batch size supports up to 50 queued entities, not 50 simultaneous external requests. External provider pacing remains in force.
- Cloudflare keeps bounded local work and supports incremental peer pulls. No volume mapping or original audio modification is required.

For an upgrade from v18.0.2, overlay the matching patch or use the full source. Back up databases and storage before deploying. Test Docker and Cloudflare separately; external service availability and live deployment are not guaranteed by local tests.

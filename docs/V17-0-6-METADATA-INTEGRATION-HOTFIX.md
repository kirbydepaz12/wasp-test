# WASP v17.0.6 — HIVE Metadata Integration Hotfix

Staging update from exactly v17.0.5. No schema changes, reset, music movement or playlist migration is required. The persistent audio player and existing telemetry event identities remain unchanged.

## Settings improvements

Admin → Network → Telemetry now has stacked provider sections, themed native controls, separate connection messages and responsive fields. The Last.fm and MusicBrainz tests can use current entered values before saving. A successful test does not save credentials. Save settings separately, then test again to verify saved configuration. Blank secret fields preserve previously stored values. Failed saves preserve entered fields so they can be retried. The interface reports HTTP status for HTML/non-JSON errors without rendering upstream HTML. An indeterminate progress bar represents a running bounded batch, then reports the actual result; it is not a percentage of the entire library. Counters show unique track/album identities and artists with verified fields, and total verified fields. Missing provider results remain unknown.

## Cloudflare setup

1. Under the test Worker's Settings → Variables and Secrets, use a persistent `METADATA_SETTINGS_KEY` secret of at least 24 characters. Generate a unique value with `openssl rand -hex 32`; never paste real keys into Git or screenshots. Existing encryption keys must remain available until previously encrypted credentials have been migrated or explicitly replaced. Do not casually change a Spotify encryption key.
2. `METADATA_SETTINGS_KEY` is an encryption key, NOT a Last.fm API key. Enter the real Last.fm API key in WASP and click Save settings, or configure `LASTFM_API_KEY` as a Worker secret. `LASTFM_SHARED_SECRET` is optional for read-only calls. Saved credentials take precedence over runtime values.
3. Choose and enable the preferred provider. MusicBrainz needs a real administrator contact email or URL, not an API key. You may disable MusicBrainz if you cannot supply a contact, but Last.fm alone does not reliably provide release years and artist origins.
4. Test the selected provider, save and test the saved configuration, then enable scheduled enrichment or run a batch manually. An HTML HTTP 503 response is not evidence of an invalid Last.fm key; inspect Worker invocation logs for the underlying failure (including Error 1102).

## Docker / Portainer setup

Set optional `METADATA_SETTINGS_KEY`, `LASTFM_API_KEY`, and `LASTFM_SHARED_SECRET` in the private stack configuration and rebuild/redeploy without deleting persistent volumes. The startup script now creates a private, mode-0600 local Wrangler `.dev.vars` file containing those supplied bindings, without copying credentials into the image or command-line arguments. Existing scanner-secret fallback remains available. The existing Spotify encryption-key binding behavior is intentionally unchanged to avoid breaking old credentials. Existing Spotify credentials are never reset by this release. Treat the app container and its private runtime filesystem as sensitive.

## Credential compatibility

The metadata credential reader attempts the configured dedicated key followed by the previous Spotify/scanner fallback keys where available. Saving a replacement encrypts with the current preferred key. If no available key decrypts older saved data, the interface asks for explicit replacement; no automatic erase occurs. Preserve old installation secrets securely until the new credentials are saved and tested. Rotate any exposed credentials carefully; use distinct keys per purpose and installation.

## Validation and limitations

The backend tests exercise provider settings, encryption/key compatibility, error responses, and generation of private local binding files. Browser tests use mocked API endpoints and assert responsive layout, credential save/test/retry, batch status and playback continuity. Live Last.fm/MusicBrainz API calls, Cloudflare Workers resource use, Docker rebuild and private-peer connectivity remain to be tested with the actual staging deployments. The existing small batch budget and metadata sharing permission defaults are unchanged. Smart Routing and automatic failover remain reserved for v18.

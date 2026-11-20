WASP v18.0.5 — CHANGES-ONLY UPGRADE PATCH

Apply ONLY to the exact WASP v18.0.4 staging source.
1. Stop writes/traffic and back up your Docker and Cloudflare persistent data.
2. Extract this patch over the SOURCE directory containing package.json, src/, public/, docs/ and tests/.
3. Keep existing .env, Cloudflare bindings, music data, persistent Docker volumes and user database.
4. Build docs: npm run build:docs
5. Run tests: npm test
6. Deploy to isolated test before production.

Included changes: 17 files; no deletions.
Important: the patch does NOT include any user's music, passwords or operational data.
No automatic deployment has been done.

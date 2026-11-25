# WASP v18.3.0b changes-only patch

Apply ONLY to the exact unmodified v18.3.0a source tree.

1. Back up the deployed source and persistent data.
2. Extract this ZIP over the contents of the existing project folder (the folder with package.json), preserving paths.
3. Do not delete Docker volumes or reset D1/R2.
4. Rebuild/redeploy Test and verify hover styling before moving to Main or Docker.

This patch contains only changed/added project files. PATCH-INSTRUCTIONS.md is informational and not part of the project.

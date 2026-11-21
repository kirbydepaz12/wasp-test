WASP v18.0.6 — HIVE Radio UI polish

Apply these files ONLY to a v18.0.5 repository. Extract this patch at the repository root; it contains only added or changed files.
Do NOT upload the full ZIP and patch together.

- Artist search suggestions are limited, keyboard accessible and anchored below the field.
- Selected genres show removable chips next to the mode selection.
- Desktop Artist/Decade, count, custom input and Generate controls align horizontally.
- Small screens wrap without horizontal overflow.
- The corrected root README.md from the user's latest documentation-only update is retained.
- No backend database migrations or music volume changes.

Test: npm test; python tests/ui_v18_0_5_radio.py; python tests/ui_v18_0_6_radio_layout.py

# Changelog

All notable changes to this project appear in this file.

## 0.1.0 - 2026-08-17

### Added

- Added an OMP extension entry point and package manifest.
- Added stable message identifiers and branch-local mutation entries.
- Added duplicate tool-result pruning and failed-tool input removal.
- Added range compression and individual-message compression.
- Added nested summary preservation and provider-native history protection.
- Added decompression, recompression, manual sweep, statistics, and TUI controls.
- Added layered JSONC configuration and a JSON Schema.
- Added live global and project prompt replacements.
- Added context-limit, turn, and iteration reminders.
- Added manual-mode grants and OMP approval policies.
- Added native-compaction reset handling and task-subagent controls.

### Compatibility

- Requires Oh My Pi 17.3.5 or later.
- Requires Bun 1.3.14 or later.
- Uses the OMP `context`, session lifecycle, command, and custom-entry APIs.
- Uses the OMP `session_init` entry to identify task subagents.
- Clears active DCP projections after native OMP compaction.

### Attribution

- Ported from `@tarquinen/opencode-dcp` 3.1.15.
- Adapted OpenCode message and persistence behavior to OMP APIs.
- Licensed under GNU AGPL-3.0-or-later.

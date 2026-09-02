# Changelog

All notable changes to this project appear in this file.

## Unreleased

### Changed

- Reused one tokenizer for token counts during the process lifetime.
- Cached token counts for unchanged tool records.
- Incrementally indexed session entries while detecting in-place message rewrites.
- Replaced a full context clone with a shallow projection copy.
- Added event-loop checkpoints with serialized context-state mutations.
- Added phase timings and warnings for context transforms that take at least 100 ms.
- Aggregated automatic tool-pruning notifications into one notice per completed agent run.
- Shortened the footer status to a cumulative removed-token count abbreviated with `k`, `M`, `B`, and `T`, without duplicating OMP's context percentage.
- Expanded detailed pruning and compression notifications with token metrics, reasons, affected tools, topics, item counts, summary cost, and context progress. Compression notices now appear immediately without interrupting the active tool run; automatic pruning retains one end-of-run chat delivery.
- Prevented `/btw` side requests from forwarding incomplete tool-call groups to the model.
- Omitted detached trailing tool results with their incomplete assistant batch, preventing invalid `orphan-result` projections.
- Preserved opaque native-compaction replay payloads and accepted only source-existing orphan results at provider replay boundaries.

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

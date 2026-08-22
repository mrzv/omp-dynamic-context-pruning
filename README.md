# OMP Dynamic Context Pruning

OMP Dynamic Context Pruning (DCP) reduces the model-visible context in long Oh My Pi sessions. It does not rewrite the saved conversation.

This extension is a modified port of `@tarquinen/opencode-dcp` 3.1.15. The port uses OMP session entries, hooks, tools, and message types.

## Requirements

- Oh My Pi 17.3.5 or later
- Bun 1.3.14 or later

## Install the extension

Install the published package:

```bash
omp plugin install omp-dynamic-context-pruning
```

For a local checkout, link the package:

```bash
omp plugin link /absolute/path/to/omp-dynamic-context-pruning
```

For one run, load the entry file directly:

```bash
omp --extension /absolute/path/to/omp-dynamic-context-pruning/src/index.ts
```

Run the package check after a source checkout:

```bash
npm install
npm run check
```

## How DCP changes context

DCP works on a copy of the messages before each model request. The saved session keeps the original messages and tool results.

DCP applies these operations:

- It replaces older duplicate tool results with fixed placeholders.
- It removes failed tool inputs after the configured number of assistant-message turns.
- It gives stable `mNNNN` identifiers to messages that the model can compress.
- It replaces selected ranges with summaries that have stable `bN` identifiers.
- It preserves tool-call and tool-result pairs.
- It preserves protected tools, protected file paths, and provider-native tool history.
- It adds context reminders when token use reaches a configured limit.

A native OMP compaction clears the active DCP projection. DCP keeps the cumulative statistics for the session.

## Configuration files

DCP reads these JSONC files in this order:

1. The global file at `$PI_CODING_AGENT_DIR/dcp.jsonc`.
2. A `dcp.jsonc` or `dcp.json` file in the nearest ancestor `.omp` directory.

The nearest `.omp` directory is the project boundary. DCP does not continue to a higher `.omp` directory when this boundary has no DCP file.

The default global directory is `~/.omp/agent`. DCP creates the global file on its first run.

The project layer overrides scalar values from the global layer. Protected-tool and protected-file arrays add values instead of replacing earlier values.

DCP rejects a layer with a parse error or an invalid value. DCP reports and ignores unknown keys, but it applies the valid keys.

Use this example as a starting configuration:

```jsonc
{
  "$schema": "https://unpkg.com/omp-dynamic-context-pruning@latest/dcp.schema.json",
  "enabled": true,
  "debug": false,
  "pruneNotification": "detailed",
  "pruneNotificationType": "chat",

  "commands": {
    "enabled": true,
    "protectedTools": ["task", "skill", "todo", "read"]
  },

  "manualMode": {
    "enabled": false,
    "automaticStrategies": true
  },

  "turnProtection": {
    "enabled": false,
    "turns": 4
  },

  "experimental": {
    "allowSubAgents": false,
    "customPrompts": false
  },

  "protectedFilePatterns": ["**/.env", "**/secrets/**"],

  "compress": {
    "mode": "range",
    "permission": "allow",
    "showCompression": false,
    "summaryBuffer": true,
    "maxContextLimit": 100000,
    "minContextLimit": 50000,
    "modelMaxLimits": {
      "anthropic/claude-sonnet-4-5": "70%"
    },
    "modelMinLimits": {},
    "nudgeFrequency": 5,
    "iterationNudgeThreshold": 15,
    "nudgeForce": "soft",
    "protectedTools": ["task", "skill", "todo"],
    "protectTags": false,
    "protectUserMessages": false
  },

  "strategies": {
    "deduplication": {
      "enabled": true,
      "protectedTools": []
    },
    "purgeErrors": {
      "enabled": true,
      "turns": 4,
      "protectedTools": []
    }
  }
}
```

### Context limits

A context limit can be a token count or a percentage string. For example, `50000` means 50,000 tokens and `"70%"` means 70 percent of the model context window.

The keys in `modelMaxLimits` and `modelMinLimits` use the `provider/model` format. A matching model value overrides the general limit.

`summaryBuffer` adds the tokens in active summaries to the maximum limit. This option prevents summaries from causing reminders too early.

### Compression modes

`range` mode compresses one or more contiguous message ranges. This mode is the default.

`message` mode compresses selected messages independently. Use this mode only when the model can select isolated messages reliably.

### Compression permission

`compress.permission` maps to the OMP approval system:

- `allow` registers the tool with automatic read-tier approval.
- `ask` requests approval before each compression call.
- `deny` does not register the tool or add compression instructions.

Automatic duplicate and failed-tool pruning can still run when the permission is `deny`.

### Manual mode

Manual mode prevents unrequested compression calls. Start one compression pass with this command:

```text
/dcp-compress
```

The command grants one `compress` call for that agent turn. DCP removes an unused grant when the turn ends.

Set `manualMode.automaticStrategies` to `false` to stop duplicate and failed-tool pruning in manual mode.

### Protected content

The core list protects stateful and destructive OMP tools from automatic pruning. User arrays can add tools but cannot remove this core protection.

`commands.protectedTools` protects manual sweep operations. `compress.protectedTools` separately preserves matching tool results verbatim in compression summaries.

`protectedFilePatterns` uses glob patterns. DCP checks paths and OMP read selectors before it prunes or compresses tool content.

Set `compress.protectTags` to preserve text inside `<protect>...</protect>` tags. Set `compress.protectUserMessages` to copy user text into summaries.

`turnProtection` prevents automatic pruning of tool calls from recent assistant-message turns. The `turns` value must be at least 1 and can include a fraction.

## Commands

| Command | Result |
| --- | --- |
| `/dcp` | Opens context statistics and controls. |
| `/dcp-compress [focus]` | Requests one compression pass. |
| `/dcp-decompress [bN]` | Restores one active compression block. |
| `/dcp-recompress [bN]` | Activates one block that the user restored. |
| `/dcp-sweep [N]` | Prunes tool results after the latest user turn or the last `N` results. |
| `/dcp-stats` | Shows token and operation totals. |

If you omit a block identifier in the TUI, DCP shows a selection list. In print mode, provide the block identifier.

## Custom prompts

Set `experimental.customPrompts` to `true` to enable prompt files. DCP creates editable copies in:

```text
$PI_CODING_AGENT_DIR/dcp-prompts/defaults/
```

Put global replacements in:

```text
$PI_CODING_AGENT_DIR/dcp-prompts/overrides/
```

Put project replacements in:

```text
.omp/dcp-prompts/overrides/
```

A project replacement has priority over a global replacement. DCP ignores an empty or malformed replacement and reports a warning.

Use **Reload prompt overrides** in `/dcp` after you edit a file. The tool description and context prompts use the new content without a restart.

## Subagents

DCP is disabled in OMP task subagents by default. The extension detects the OMP `session_init` entry that identifies a task session.

Set `experimental.allowSubAgents` to `true` to enable DCP in task subagents. The first subagent instruction remains protected.

## Notifications and state

`pruneNotification` controls the detail level. `pruneNotificationType` selects chat messages or TUI notifications. Automatic tool-pruning notices are aggregated across the agent run and emitted once when the run finishes; manual command feedback remains immediate.

DCP removes its chat notifications from model input. The messages remain visible to the user.

DCP stores versioned mutation entries in the OMP session. Branches reconstruct only the state in their selected history.

## Operational notes

Context pruning changes the exact provider prompt. As a result, provider prompt-cache hits can decrease after the first changed message.

DCP invalidates provider-native replay data when it changes message content. It does not compress provider-native tool-call groups.

The extension supports the OMP APIs in version 17.3.5. A later OMP message or session format can require a compatibility update.

When `debug` is `true`, DCP logs phase timings and cache statistics for each context transform. DCP always logs a warning for transforms that take at least 100 ms.

## License and attribution

This project uses the GNU Affero General Public License, version 3 or later. Read `LICENSE` and `NOTICE` for the full terms and upstream attribution.

# Simply Xcode Build

`simplybuild` is a smart CLI wrapper around `xcodebuildmcp` for one-command iOS build, deploy, and launch.

## Requirements

- macOS with Xcode
- Node.js 20+
- `xcodebuildmcp` available in `PATH`

## Install (local repo)

```bash
npm install
npm run build
```

Run directly:

```bash
node dist/cli.js --help
```

## Usage

```bash
simplybuild
simplybuild "screenager"
simplybuild --device "iPhone 15"
simplybuild --scheme MyApp "iPad"
simplybuild --list-devices
simplybuild --list-projects
simplybuild --verbose
simplybuild --help
```

## Behavior

- Auto-discovers `.xcworkspace`/`.xcodeproj` recursively from current directory.
- If none are found, prompts to search parent directories.
- Auto-discovers schemes with `xcodebuild -list -json`.
- Uses fuzzy target matching for positional query input.
- Falls back to interactive Clack selectors when matching is ambiguous or weak.
- `--device` requires exact name match (case-insensitive).
- Physical deployment asks for one-time confirmation per `{project, deviceId}` and remembers approval.
- Remembers last successful project/scheme/target context.

## State file

State is persisted at:

- `$XDG_STATE_HOME/simplybuild/state.json` (if `XDG_STATE_HOME` is set)
- otherwise `~/.local/state/simplybuild/state.json`

Corrupt state files are automatically backed up as:

- `state.json.corrupt-<timestamp>`

## Notes

- `--watch` is intentionally not implemented in v1.
- In non-interactive (no TTY) mode, commands fail fast when a prompt would be required.

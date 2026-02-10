# Simply Xcode Build

`simplybuild` is a smart CLI wrapper around `xcodebuildmcp` for one-command iOS build, deploy, and launch.

## Requirements

- macOS with Xcode
- Node.js 20+
- `xcodebuildmcp` available in `PATH` (interactive runs can install it automatically)

## Install

```bash
npm install -g @kainoa/simplybuild
```

Then run:

```bash
simplybuild --help
```

`sb` is the short alias and works for all the same commands as `simplybuild`.

## Usage

```bash
simplybuild --help
simplybuild "screenager"
simplybuild --device "iPhone 15"
simplybuild --scheme MyApp
simplybuild --list-devices
simplybuild --list-projects
simplybuild --verbose
```

## Behavior

- Auto-discovers `.xcworkspace` and `.xcodeproj` recursively from the current directory.
- Prompts to search parent directories if no containers are found.
- Auto-discovers schemes with `xcodebuild -list -json`.
- Falls back to interactive Clack selectors when target selection is required.
- Requires exact `--device` name matching (case-insensitive).
- Prompts once per project/device pair before physical deployment.
- Checks for `xcodebuildmcp` at startup and can offer to install it in interactive mode.

## Contributing

For local development:

```bash
npm install
npm run build
npm test
```

Run from source:

```bash
node dist/cli.js --help
```

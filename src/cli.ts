#!/usr/bin/env node

import { runSimplyBuild } from "./app/runSimplyBuild.js";
import { UserCancelledError, UserFacingError, type CliOptions } from "./types.js";

const HELP_TEXT = `simplybuild - Smart iOS build/deploy wrapper for xcodebuildmcp

Usage:
  simplybuild
  simplybuild "screenager"
  simplybuild --device "iPhone 15"
  simplybuild --scheme MyApp "iPad"
  simplybuild --list-devices
  simplybuild --list-projects
  simplybuild --help

Options:
  --device <name>      Exact target name match (case-insensitive)
  --scheme <scheme>    Explicit Xcode scheme
  --list-devices       List available physical devices and simulators
  --list-projects      List discovered .xcodeproj/.xcworkspace in current directory tree
  --verbose            Stream underlying command output
  --help, -h           Show this help
`;

function requireValue(flag: string, argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new UserFacingError(`Missing value for ${flag}`);
  }
  return value;
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    listDevices: false,
    listProjects: false,
    verbose: false,
    help: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--list-devices":
        options.listDevices = true;
        break;
      case "--list-projects":
        options.listProjects = true;
        break;
      case "--device":
        options.device = requireValue("--device", argv, i);
        i += 1;
        break;
      case "--scheme":
        options.scheme = requireValue("--scheme", argv, i);
        i += 1;
        break;
      default:
        if (arg.startsWith("-")) {
          if (arg === "--watch") {
            throw new UserFacingError(
              "--watch is intentionally not implemented in simplybuild v1.",
            );
          }
          throw new UserFacingError(`Unknown option: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }

  if (positional.length > 0) {
    options.query = positional.join(" ");
  }

  if (options.listDevices && options.listProjects) {
    throw new UserFacingError("Use either --list-devices or --list-projects, not both.");
  }

  return options;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseCliOptions(argv);

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  await runSimplyBuild(options);
}

main().catch((error: unknown) => {
  if (error instanceof UserCancelledError) {
    process.exitCode = 130;
    return;
  }

  if (error instanceof UserFacingError) {
    console.error(`Error: ${error.message}`);
    for (const detail of error.details ?? []) {
      console.error(detail);
    }
    process.exitCode = 1;
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});

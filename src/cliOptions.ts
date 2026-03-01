import { UserFacingError, type CliOptions } from "./types.js";

export const HELP_TEXT = `simplybuild - Smart iOS build/deploy wrapper for xcodebuildmcp

Usage:
  simplybuild --help
  sb --help
  simplebuild --help
  simplybuild "screenager"
  simplybuild --device "iPhone 15"
  simplybuild --scheme MyApp
  simplybuild --list-devices
  simplybuild --list-projects

Options:
  --device <name>      Exact target name match (case-insensitive)
  --scheme <scheme>    Explicit Xcode scheme
  --list-devices       List available physical devices and simulators
  --list-projects      List discovered .xcodeproj/.xcworkspace in current directory tree
  --verbose            Stream underlying command output
  --help, help         Show this help
  --h, -h, -help, h    Additional help aliases

Aliases:
  simplebuild, simple-build, simply-build
  symplebuild, symplybuild, symple-build, symply-build
`;

export interface ParsedCliOptions {
  options: CliOptions;
  parseError?: string;
}

function requireValue(flag: string, argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new UserFacingError(`Missing value for ${flag}`);
  }
  return value;
}

export function parseCliOptions(argv: string[]): ParsedCliOptions {
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
      case "-help":
      case "--h":
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
          return {
            options: {
              ...options,
              help: true,
            },
            parseError:
              arg === "--watch"
                ? "--watch is intentionally not implemented in simplybuild v1."
                : `Unknown option: ${arg}`,
          };
        }
        positional.push(arg);
        break;
    }
  }

  const isHelpAlias =
    positional.length === 1 &&
    ["help", "h"].includes(positional[0].toLowerCase()) &&
    !options.device &&
    !options.scheme &&
    !options.listDevices &&
    !options.listProjects;

  if (isHelpAlias) {
    options.help = true;
    return { options };
  }

  if (options.listDevices && options.listProjects) {
    return {
      options: {
        ...options,
        help: true,
      },
      parseError: "Use either --list-devices or --list-projects, not both.",
    };
  }

  if (positional.length > 0) {
    if (options.device) {
      return {
        options: {
          ...options,
          help: true,
        },
        parseError: "Use either a positional target query or --device, not both.",
      };
    }

    if (options.listDevices || options.listProjects) {
      return {
        options: {
          ...options,
          help: true,
        },
        parseError: "Positional target queries cannot be combined with list commands.",
      };
    }

    options.query = positional.join(" ");
  }

  return { options };
}

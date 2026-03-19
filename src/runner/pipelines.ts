import type { ProjectCandidate, TargetCandidate } from "../types.js";
import { UserCancelledError, UserFacingError } from "../types.js";
import type { PromptApi } from "../ui/prompts.js";
import type { CommandResult } from "../types.js";
import { runCommand } from "./commandRunner.js";
import {
  runXcodebuildmcpTool,
  type ToolCommandResult,
} from "./xcodebuildmcpRunner.js";

export interface PipelineContext {
  container: ProjectCandidate;
  scheme: string;
  target: TargetCandidate;
  verbose: boolean;
}

export interface PipelineDependencies {
  runTool: (args: string[], options: { verbose?: boolean }) => Promise<ToolCommandResult>;
  runRaw: (
    command: string,
    args: string[],
    options: { verbose?: boolean },
  ) => Promise<CommandResult>;
}

const LOCKED_DEVICE_MARKERS = [
  "device is locked",
  "kAMDMobileImageMounterDeviceLocked",
  "0xE80000E2",
] as const;

const INSTALL_NOT_CONNECTED_MARKERS = [
  "unable to locate a device matching the requested device identifier",
  "a connection to this device could not be established",
  "the peer is no longer reachable",
  "connection was invalidated",
  "com.apple.dt.CoreDeviceError error 1011",
  "com.apple.dt.CoreDeviceError error 4000",
  "0x3F3",
  "0xFA0",
  "DeviceIdentifier: ecid_",
  "DeviceIdentifier = ecid_",
] as const;

const LAUNCH_LOCKED_REASON_MARKERS = [
  "could not be unlocked",
  "device was not, or could not be, unlocked",
  "BSErrorCodeDescription = Locked",
  "for reason: Locked",
  "because the device was not, or could not be, unlocked",
] as const;

const LAUNCH_LOCKED_CONTEXT_MARKERS = [
  "com.apple.dt.CoreDeviceError error 10002",
  "0x2712",
  "FBSOpenApplicationErrorDomain error 7",
  "FBSOpenApplicationServiceErrorDomain error 1",
] as const;

const LAUNCH_DISCONNECTED_MARKERS = [
  "device disconnected immediately after connecting",
  "com.apple.dt.CoreDeviceError error 4000",
  "0xFA0",
] as const;

type PhysicalRecoveryAction = "retry" | "cancel";

interface RecoverablePhysicalFailureHandler {
  matches: (result: ToolCommandResult, ctx: PipelineContext) => boolean;
  interactiveWarning: (ctx: PipelineContext) => string;
  nonInteractiveMessage: (ctx: PipelineContext) => string;
  cancellationMessage: string;
  details?: (result: ToolCommandResult) => string[];
}

function containerArgs(container: ProjectCandidate): string[] {
  return container.kind === "workspace"
    ? ["--workspace-path", container.path]
    : ["--project-path", container.path];
}

function normalizeFailureBlock(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function appendUniqueBlock(blocks: string[], label: string, value: string | undefined): void {
  const normalized = normalizeFailureBlock(value);
  if (!normalized) {
    return;
  }

  const formatted = `${label}:\n${normalized}`;
  if (!blocks.includes(formatted)) {
    blocks.push(formatted);
  }
}

function formatToolFailureDetails(result: ToolCommandResult): string[] {
  const details: string[] = [];

  if (result.code !== 0) {
    details.push(`Exit code: ${result.code}`);
  }

  appendUniqueBlock(details, "Tool response", result.response.text);
  appendUniqueBlock(details, "stderr", result.stderr);
  appendUniqueBlock(details, "stdout", result.stdout);

  return details;
}

function assertToolSuccess(result: ToolCommandResult, fallbackLabel: string): void {
  if (!result.ok || result.response.isError) {
    const details = formatToolFailureDetails(result);
    throw new UserFacingError(
      fallbackLabel,
      details.length > 0 ? details : undefined,
    );
  }
}

function formatInstallNotConnectedDetails(result: ToolCommandResult): string[] {
  return [
    "Your Mac can see the phone, but it cannot reach it well enough to install the app.",
    "Make sure the phone is unlocked and either on the same Wi-Fi network as your Mac or connected with USB.",
    "Then try again.",
    ...formatToolFailureDetails(result),
  ];
}

function failureText(result: ToolCommandResult): string {
  if (result.ok && !result.response.isError) {
    return "";
  }

  return [result.response.text, result.stdout, result.stderr]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();
}

function matchesFailureMarkers(result: ToolCommandResult, markers: readonly string[]): boolean {
  const combined = failureText(result);
  if (!combined) {
    return false;
  }

  return markers.some((marker) => combined.includes(marker.toLowerCase()));
}

function matchesLaunchLockedFailure(result: ToolCommandResult): boolean {
  return (
    matchesFailureMarkers(result, LAUNCH_LOCKED_REASON_MARKERS) &&
    matchesFailureMarkers(result, LAUNCH_LOCKED_CONTEXT_MARKERS)
  );
}

async function runRetryablePhysicalStep(
  ctx: PipelineContext,
  prompts: PromptApi,
  deps: PipelineDependencies,
  options: {
    stageMessage: string;
    failureMessage: string;
    args: string[];
    handlers: RecoverablePhysicalFailureHandler[];
  },
): Promise<void> {
  while (true) {
    let stepResult: ToolCommandResult | undefined;

    try {
      await prompts.stage(options.stageMessage, async () => {
        stepResult = await deps.runTool(options.args, { verbose: ctx.verbose });
        assertToolSuccess(stepResult, options.failureMessage);
      });
      return;
    } catch (error) {
      if (!stepResult) {
        throw error;
      }

      const result = stepResult;
      const handler = options.handlers.find((candidate) => candidate.matches(result, ctx));
      if (!handler) {
        throw error;
      }

      const details = handler.details?.(result) ?? formatToolFailureDetails(result);
      if (!prompts.interactive) {
        throw new UserFacingError(
          handler.nonInteractiveMessage(ctx),
          details.length > 0 ? details : undefined,
        );
      }

      prompts.warn(handler.interactiveWarning(ctx));
      const action = await prompts.select<PhysicalRecoveryAction>(
        "What would you like to do?",
        [
          { value: "retry", label: "Try again" },
          { value: "cancel", label: "Cancel" },
        ],
        "retry",
      );

      if (action === "cancel") {
        throw new UserCancelledError(handler.cancellationMessage);
      }
    }
  }
}

export function parseAppPathFromToolText(text: string): string | undefined {
  const patterns = [
    /App path retrieved successfully:\s*(.+?\.app)\b/i,
    /\b(CODESIGNING_FOLDER_PATH|APP_PATH)\s*[=:]\s*(.+?\.app)\b/i,
    /\b(\/[^\s]+\.app)\b/g,
  ];

  const direct = text.match(patterns[0]) || text.match(patterns[1]);
  if (direct?.[2]) {
    return direct[2].trim();
  }

  if (direct?.[1] && direct[0].includes(".app")) {
    return direct[1].trim();
  }

  const all = [...text.matchAll(patterns[2])];
  if (all.length > 0) {
    return all[all.length - 1][1].trim();
  }

  return undefined;
}

export function parseBundleIdFromToolText(text: string): string | undefined {
  const match = text.match(/Bundle ID:\s*([A-Za-z0-9._-]+)/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return undefined;
}

export function parseAppPathFromBuildSettings(settings: string): string | undefined {
  const codeSigningMatch = settings.match(/CODESIGNING_FOLDER_PATH\s*=\s*(.+\.app)/);
  if (codeSigningMatch?.[1]) {
    return codeSigningMatch[1].trim();
  }

  const builtDirMatch = settings.match(/^\s*BUILT_PRODUCTS_DIR\s*=\s*(.+)$/m);
  const productMatch = settings.match(/^\s*FULL_PRODUCT_NAME\s*=\s*(.+)$/m);
  if (builtDirMatch?.[1] && productMatch?.[1]) {
    return `${builtDirMatch[1].trim()}/${productMatch[1].trim()}`;
  }

  return undefined;
}

async function fallbackResolveAppPath(
  ctx: PipelineContext,
  deps: PipelineDependencies,
): Promise<string> {
  const args = ["-showBuildSettings"];

  if (ctx.container.kind === "workspace") {
    args.push("-workspace", ctx.container.path);
  } else {
    args.push("-project", ctx.container.path);
  }

  args.push("-scheme", ctx.scheme, "-configuration", "Debug", "-destination", "generic/platform=iOS");

  const result = await deps.runRaw("xcodebuild", args, { verbose: false });
  if (!result.ok) {
    throw new UserFacingError(
      "Failed to determine built app path from build settings.",
      [result.stderr || result.stdout],
    );
  }

  const appPath = parseAppPathFromBuildSettings(result.stdout);
  if (!appPath) {
    throw new UserFacingError("Could not extract app path from xcodebuild settings output.");
  }

  return appPath;
}

async function fallbackResolveBundleId(
  appPath: string,
  deps: PipelineDependencies,
): Promise<string> {
  const plistPath = `${appPath}/Info.plist`;
  const result = await deps.runRaw(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", plistPath],
    { verbose: false },
  );

  if (!result.ok) {
    throw new UserFacingError(
      "Failed to extract bundle ID from app bundle.",
      [result.stderr || result.stdout],
    );
  }

  const value = result.stdout.trim();
  if (!value) {
    throw new UserFacingError("Bundle ID extraction returned an empty value.");
  }

  return value;
}

export async function runSimulatorPipeline(
  ctx: PipelineContext,
  prompts: PromptApi,
  deps: PipelineDependencies = {
    runTool: (args, options) => runXcodebuildmcpTool(args, options),
    runRaw: (command, args, options) => runCommand(command, args, options),
  },
): Promise<void> {
  await prompts.stage(
    `Building and launching ${ctx.scheme} on simulator ${ctx.target.name}`,
    async () => {
      const result = await deps.runTool(
        [
          "simulator",
          "build-and-run",
          ...containerArgs(ctx.container),
          "--scheme",
          ctx.scheme,
          "--simulator-id",
          ctx.target.id,
          "--configuration",
          "Debug",
        ],
        { verbose: ctx.verbose },
      );
      assertToolSuccess(result, "Simulator build/run failed.");
    },
    {
      success: `Launched ${ctx.scheme} on ${ctx.target.name}`,
      error: `Failed to launch ${ctx.scheme} on ${ctx.target.name}`,
    },
  );
}

export async function runPhysicalPipeline(
  ctx: PipelineContext,
  prompts: PromptApi,
  deps: PipelineDependencies = {
    runTool: (args, options) => runXcodebuildmcpTool(args, options),
    runRaw: (command, args, options) => runCommand(command, args, options),
  },
): Promise<void> {
  const baseArgs = containerArgs(ctx.container);
  const installHandlers: RecoverablePhysicalFailureHandler[] = [
    {
      matches: (result) => matchesFailureMarkers(result, INSTALL_NOT_CONNECTED_MARKERS),
      interactiveWarning: (currentCtx) =>
        `${currentCtx.target.name} is not reachable from this Mac right now. Unlock it, put it on the same Wi-Fi network as your Mac or connect it with USB, then try again.`,
      nonInteractiveMessage: (currentCtx) =>
        `${currentCtx.target.name} is not reachable from this Mac right now. Unlock it, put it on the same Wi-Fi network as your Mac or connect it with USB, then run simplybuild again.`,
      cancellationMessage:
        "Physical deployment cancelled while the device remained unavailable for install.",
      details: formatInstallNotConnectedDetails,
    },
    {
      matches: (result) => matchesFailureMarkers(result, LOCKED_DEVICE_MARKERS),
      interactiveWarning: (currentCtx) =>
        `${currentCtx.target.name} is locked. Please unlock your device to continue.`,
      nonInteractiveMessage: () =>
        "Physical device is locked. Unlock the device and run the command again.",
      cancellationMessage: "Physical deployment cancelled while device remained locked.",
    },
  ];

  const launchHandlers: RecoverablePhysicalFailureHandler[] = [
    {
      matches: (result) => matchesLaunchLockedFailure(result),
      interactiveWarning: (currentCtx) =>
        `${currentCtx.target.name} is locked. Please unlock your device to continue.`,
      nonInteractiveMessage: () =>
        "Physical device is locked. Unlock the device and run the command again.",
      cancellationMessage: "Physical deployment cancelled while device remained locked.",
    },
    {
      matches: (result) => matchesFailureMarkers(result, LAUNCH_DISCONNECTED_MARKERS),
      interactiveWarning: (currentCtx) =>
        `${currentCtx.target.name} disconnected while launching the app. Reconnect it or make sure it stays reachable, then try again.`,
      nonInteractiveMessage: () =>
        "Physical device disconnected while launching the app. Reconnect it or make sure it stays reachable, then run the command again.",
      cancellationMessage:
        "Physical deployment cancelled while the device remained disconnected during launch.",
    },
  ];

  await prompts.stage(`Building ${ctx.scheme} for physical device`, async () => {
    const result = await deps.runTool(
      ["device", "build", ...baseArgs, "--scheme", ctx.scheme, "--configuration", "Debug"],
      { verbose: ctx.verbose },
    );
    assertToolSuccess(result, "Device build failed.");
  });

  const appPath = await prompts.stage("Resolving built app path", async () => {
    const pathResult = await deps.runTool(
      ["device", "get-app-path", ...baseArgs, "--scheme", ctx.scheme, "--platform", "iOS"],
      { verbose: false },
    );
    assertToolSuccess(pathResult, "Failed to get built app path.");

    const parsed = parseAppPathFromToolText(pathResult.response.text);
    if (parsed) {
      return parsed;
    }

    return fallbackResolveAppPath(ctx, deps);
  });

  const bundleId = await prompts.stage("Resolving app bundle identifier", async () => {
    const bundleResult = await deps.runTool(
      ["project-discovery", "get-app-bundle-id", "--app-path", appPath],
      { verbose: false },
    );
    assertToolSuccess(bundleResult, "Failed to resolve app bundle identifier.");

    const parsed = parseBundleIdFromToolText(bundleResult.response.text);
    if (parsed) {
      return parsed;
    }

    return fallbackResolveBundleId(appPath, deps);
  });

  await runRetryablePhysicalStep(ctx, prompts, deps, {
    stageMessage: `Installing app on ${ctx.target.name}`,
    failureMessage: "Failed to install app on physical device.",
    args: [
      "device",
      "install",
      "--device-id",
      ctx.target.id,
      "--app-path",
      appPath,
    ],
    handlers: installHandlers,
  });

  await runRetryablePhysicalStep(ctx, prompts, deps, {
    stageMessage: `Launching app (${bundleId}) on ${ctx.target.name}`,
    failureMessage: "Failed to launch app on physical device.",
    args: [
      "device",
      "launch",
      "--device-id",
      ctx.target.id,
      "--bundle-id",
      bundleId,
    ],
    handlers: launchHandlers,
  });
}

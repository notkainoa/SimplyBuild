import type { ProjectCandidate, TargetCandidate } from "../types.js";
import { UserFacingError } from "../types.js";
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

  await prompts.stage(`Installing app on ${ctx.target.name}`, async () => {
    const installResult = await deps.runTool(
      [
        "device",
        "install",
        "--device-id",
        ctx.target.id,
        "--app-path",
        appPath,
      ],
      { verbose: ctx.verbose },
    );
    assertToolSuccess(installResult, "Failed to install app on physical device.");
  });

  await prompts.stage(`Launching app (${bundleId}) on ${ctx.target.name}`, async () => {
    const launchResult = await deps.runTool(
      [
        "device",
        "launch",
        "--device-id",
        ctx.target.id,
        "--bundle-id",
        bundleId,
      ],
      { verbose: ctx.verbose },
    );
    assertToolSuccess(launchResult, "Failed to launch app on physical device.");
  });
}

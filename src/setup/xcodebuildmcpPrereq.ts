import { runCommand } from "../runner/commandRunner.js";
import type { CommandResult } from "../types.js";
import { UserFacingError } from "../types.js";
import type { PromptApi } from "../ui/prompts.js";

const REQUIRED_TOOL = "xcodebuildmcp";
const INSTALL_ARGS = ["install", "-g", REQUIRED_TOOL];
const INSTALL_COMMAND_TEXT = `npm ${INSTALL_ARGS.join(" ")}`;

interface EnsureXcodebuildmcpReadyDependencies {
  runRaw?: (
    command: string,
    args: string[],
    options: { verbose?: boolean },
  ) => Promise<CommandResult>;
}

interface CommandFailureResult {
  type: "result";
  result: CommandResult;
}

interface CommandFailureError {
  type: "error";
  error: unknown;
}

type CommandFailure = CommandFailureResult | CommandFailureError;

interface ProbeResultReady {
  status: "ready";
}

interface ProbeResultMissing {
  status: "missing";
}

interface ProbeResultFailed {
  status: "failed";
  failure: CommandFailure;
}

type ProbeResult = ProbeResultReady | ProbeResultMissing | ProbeResultFailed;

function standardHelpDetails(extra: string[] = []): string[] {
  return [
    `Required dependency: ${REQUIRED_TOOL}`,
    `Install it with: ${INSTALL_COMMAND_TEXT}`,
    "Global npm installs may require elevated permissions depending on your npm prefix.",
    ...extra,
  ];
}

function formatFailureDetail(failure: CommandFailure): string | undefined {
  if (failure.type === "result") {
    const detail = (failure.result.stderr || failure.result.stdout).trim();
    return detail.length > 0 ? detail : undefined;
  }

  if (failure.error instanceof Error && failure.error.message.trim().length > 0) {
    return failure.error.message.trim();
  }

  return undefined;
}

function isMissingBinaryError(error: unknown, command: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errno = error as NodeJS.ErrnoException;
  if (errno.code !== "ENOENT") {
    return false;
  }

  if (errno.path === command) {
    return true;
  }

  return typeof errno.message === "string" && errno.message.includes(command);
}

async function probeXcodebuildmcp(
  runRaw: (
    command: string,
    args: string[],
    options: { verbose?: boolean },
  ) => Promise<CommandResult>,
): Promise<ProbeResult> {
  try {
    const result = await runRaw(REQUIRED_TOOL, ["--version"], { verbose: false });
    if (result.ok) {
      return { status: "ready" };
    }

    return {
      status: "failed",
      failure: {
        type: "result",
        result,
      },
    };
  } catch (error) {
    if (isMissingBinaryError(error, REQUIRED_TOOL)) {
      return { status: "missing" };
    }

    return {
      status: "failed",
      failure: {
        type: "error",
        error,
      },
    };
  }
}

export async function ensureXcodebuildmcpReady(
  prompts: PromptApi,
  verbose: boolean,
  deps: EnsureXcodebuildmcpReadyDependencies = {},
): Promise<void> {
  const runRaw = deps.runRaw ?? ((command, args, options) => runCommand(command, args, options));
  const initialProbe = await probeXcodebuildmcp(runRaw);

  if (initialProbe.status === "ready") {
    return;
  }

  if (initialProbe.status === "failed") {
    throw new UserFacingError(
      "Failed to verify `xcodebuildmcp` availability.",
      standardHelpDetails(
        formatFailureDetail(initialProbe.failure)
          ? [`Probe error: ${formatFailureDetail(initialProbe.failure)}`]
          : [],
      ),
    );
  }

  if (!prompts.interactive) {
    throw new UserFacingError(
      "`xcodebuildmcp` is required for simplybuild.",
      standardHelpDetails([
        "Automatic installation requires an interactive terminal.",
      ]),
    );
  }

  prompts.warn("`xcodebuildmcp` is required for simplybuild.");
  const shouldInstall = await prompts.confirm(
    "Install `xcodebuildmcp` now with `npm install -g xcodebuildmcp`?",
    true,
  );

  if (!shouldInstall) {
    throw new UserFacingError(
      "`xcodebuildmcp` is required for simplybuild.",
      standardHelpDetails(["Installation was declined."]),
    );
  }

  const installResult = await prompts.stage(
    "Installing xcodebuildmcp globally",
    async () => {
      try {
        return await runRaw("npm", INSTALL_ARGS, { verbose });
      } catch (error) {
        throw new UserFacingError(
          "Failed to install `xcodebuildmcp` automatically.",
          standardHelpDetails(
            formatFailureDetail({ type: "error", error })
              ? [`Install error: ${formatFailureDetail({ type: "error", error })}`]
              : [],
          ),
        );
      }
    },
    {
      success: "Installed xcodebuildmcp",
      error: "Failed to install xcodebuildmcp",
    },
  );

  if (!installResult.ok) {
    const installFailure: CommandFailure = {
      type: "result",
      result: installResult,
    };
    throw new UserFacingError(
      "Failed to install `xcodebuildmcp` automatically.",
      standardHelpDetails(
        formatFailureDetail(installFailure)
          ? [`Install error: ${formatFailureDetail(installFailure)}`]
          : [],
      ),
    );
  }

  const postInstallProbe = await probeXcodebuildmcp(runRaw);
  if (postInstallProbe.status === "ready") {
    return;
  }

  if (postInstallProbe.status === "missing") {
    throw new UserFacingError(
      "`xcodebuildmcp` was installed but is not available in the current PATH.",
      standardHelpDetails([
        "Open a new terminal session and verify with `which xcodebuildmcp`.",
      ]),
    );
  }

  throw new UserFacingError(
    "Failed to verify `xcodebuildmcp` after installation.",
    standardHelpDetails(
      formatFailureDetail(postInstallProbe.failure)
        ? [`Probe error: ${formatFailureDetail(postInstallProbe.failure)}`]
        : [],
    ),
  );
}

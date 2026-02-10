import { describe, expect, it, vi } from "vitest";
import { ensureXcodebuildmcpReady } from "../src/setup/xcodebuildmcpPrereq.js";
import type { CommandResult } from "../src/types.js";
import type { PromptApi } from "../src/ui/prompts.js";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    code: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function missingCommandError(command = "xcodebuildmcp"): NodeJS.ErrnoException {
  const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.path = command;
  return error;
}

function buildPrompts(config?: { interactive?: boolean; confirmResult?: boolean }): {
  prompts: PromptApi;
  confirmMock: ReturnType<typeof vi.fn>;
  warnMock: ReturnType<typeof vi.fn>;
  stageMock: ReturnType<typeof vi.fn>;
} {
  const interactive = config?.interactive ?? true;
  const confirmResult = config?.confirmResult ?? true;
  const confirmMock = vi.fn(async () => confirmResult);
  const warnMock = vi.fn();
  const stageMock = vi.fn(async (_message: string, task: () => Promise<unknown>) => task());

  return {
    prompts: {
      interactive,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: warnMock,
      step: () => undefined,
      select: async () => {
        throw new Error("not used");
      },
      confirm: confirmMock,
      text: async () => {
        throw new Error("not used");
      },
      stage: stageMock,
    },
    confirmMock,
    warnMock,
    stageMock,
  };
}

describe("ensureXcodebuildmcpReady", () => {
  it("returns when xcodebuildmcp is already available", async () => {
    const runRaw = vi.fn().mockResolvedValueOnce(commandResult());
    const { prompts, confirmMock, stageMock } = buildPrompts();

    await ensureXcodebuildmcpReady(prompts, false, { runRaw });

    expect(runRaw).toHaveBeenCalledTimes(1);
    expect(runRaw).toHaveBeenCalledWith("xcodebuildmcp", ["--version"], { verbose: false });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(stageMock).not.toHaveBeenCalled();
  });

  it("installs xcodebuildmcp after interactive confirmation when missing", async () => {
    const runRaw = vi
      .fn()
      .mockRejectedValueOnce(missingCommandError())
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: "2.0.5\n" }));
    const { prompts, confirmMock, warnMock, stageMock } = buildPrompts({
      interactive: true,
      confirmResult: true,
    });

    await ensureXcodebuildmcpReady(prompts, false, { runRaw });

    expect(warnMock).toHaveBeenCalledWith("`xcodebuildmcp` is required for simplybuild.");
    expect(confirmMock).toHaveBeenCalledWith(
      "Install `xcodebuildmcp` now with `npm install -g xcodebuildmcp`?",
      true,
    );
    expect(stageMock).toHaveBeenCalledTimes(1);
    expect(runRaw).toHaveBeenNthCalledWith(2, "npm", ["install", "-g", "xcodebuildmcp"], {
      verbose: false,
    });
    expect(runRaw).toHaveBeenNthCalledWith(3, "xcodebuildmcp", ["--version"], {
      verbose: false,
    });
  });

  it("throws guided error when interactive install is declined", async () => {
    const runRaw = vi.fn().mockRejectedValueOnce(missingCommandError());
    const { prompts } = buildPrompts({
      interactive: true,
      confirmResult: false,
    });

    await expect(ensureXcodebuildmcpReady(prompts, false, { runRaw })).rejects.toMatchObject({
      message: "`xcodebuildmcp` is required for simplybuild.",
      details: expect.arrayContaining(["Installation was declined."]),
    });
    expect(runRaw).toHaveBeenCalledTimes(1);
  });

  it("throws guided error in non-interactive mode when missing", async () => {
    const runRaw = vi.fn().mockRejectedValueOnce(missingCommandError());
    const { prompts, confirmMock } = buildPrompts({
      interactive: false,
    });

    await expect(ensureXcodebuildmcpReady(prompts, false, { runRaw })).rejects.toMatchObject({
      message: "`xcodebuildmcp` is required for simplybuild.",
      details: expect.arrayContaining([
        "Automatic installation requires an interactive terminal.",
      ]),
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(runRaw).toHaveBeenCalledTimes(1);
  });

  it("throws guided error when automatic install command fails", async () => {
    const runRaw = vi
      .fn()
      .mockRejectedValueOnce(missingCommandError())
      .mockResolvedValueOnce(
        commandResult({
          ok: false,
          code: 1,
          stderr: "EACCES: permission denied",
        }),
      );
    const { prompts } = buildPrompts({
      interactive: true,
      confirmResult: true,
    });

    await expect(ensureXcodebuildmcpReady(prompts, false, { runRaw })).rejects.toMatchObject({
      message: "Failed to install `xcodebuildmcp` automatically.",
      details: expect.arrayContaining(["Install error: EACCES: permission denied"]),
    });
    expect(runRaw).toHaveBeenCalledTimes(2);
  });

  it("throws PATH guidance when post-install probe still cannot find binary", async () => {
    const runRaw = vi
      .fn()
      .mockRejectedValueOnce(missingCommandError())
      .mockResolvedValueOnce(commandResult())
      .mockRejectedValueOnce(missingCommandError());
    const { prompts } = buildPrompts({
      interactive: true,
      confirmResult: true,
    });

    await expect(ensureXcodebuildmcpReady(prompts, false, { runRaw })).rejects.toMatchObject({
      message: "`xcodebuildmcp` was installed but is not available in the current PATH.",
      details: expect.arrayContaining([
        "Open a new terminal session and verify with `which xcodebuildmcp`.",
      ]),
    });
    expect(runRaw).toHaveBeenCalledTimes(3);
  });

  it("does not offer install for non-missing probe failures", async () => {
    const probeError = new Error("spawn xcodebuildmcp EPERM");
    const runRaw = vi.fn().mockRejectedValueOnce(probeError);
    const { prompts, confirmMock } = buildPrompts({
      interactive: true,
      confirmResult: true,
    });

    await expect(ensureXcodebuildmcpReady(prompts, false, { runRaw })).rejects.toMatchObject({
      message: "Failed to verify `xcodebuildmcp` availability.",
      details: expect.arrayContaining(["Probe error: spawn xcodebuildmcp EPERM"]),
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(runRaw).toHaveBeenCalledTimes(1);
  });
});

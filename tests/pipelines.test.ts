import { describe, expect, it, vi } from "vitest";
import {
  parseAppPathFromBuildSettings,
  parseAppPathFromToolText,
  parseBundleIdFromToolText,
  runPhysicalPipeline,
  runSimulatorPipeline,
} from "../src/runner/pipelines.js";
import { UserCancelledError, UserFacingError } from "../src/types.js";
import type { PromptApi } from "../src/ui/prompts.js";
import type { ToolCommandResult } from "../src/runner/xcodebuildmcpRunner.js";
import type { TargetCandidate } from "../src/types.js";

function toolResult(text: string): ToolCommandResult {
  return {
    ok: true,
    code: 0,
    stdout: "{}",
    stderr: "",
    response: {
      text,
      isError: false,
      json: {},
    },
  };
}

function failedToolResult(
  text: string,
  overrides: Partial<ToolCommandResult> = {},
): ToolCommandResult {
  return {
    ok: false,
    code: 1,
    stdout: text,
    stderr: "",
    response: {
      text,
      isError: true,
      json: {},
    },
    ...overrides,
  };
}

function physicalContext(targetOverrides: Partial<TargetCandidate> = {}) {
  return {
    container: {
      kind: "workspace" as const,
      path: "/repo/App.xcworkspace",
      name: "App",
    },
    scheme: "App",
    target: {
      kind: "physical" as const,
      id: "DEVICE-1",
      name: "Screenager",
      os: "iOS 26.2",
      state: "Available",
      connectionState: "connected" as const,
      ...targetOverrides,
    },
    verbose: false,
  };
}

function nonInteractivePrompts(): PromptApi {
  return {
    interactive: false,
    intro: () => undefined,
    outro: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    step: () => undefined,
    select: async () => {
      throw new Error("not used");
    },
    confirm: async () => {
      throw new Error("not used");
    },
    text: async () => {
      throw new Error("not used");
    },
    stage: async (_message, task) => task(),
  };
}

describe("pipeline parsing helpers", () => {
  it("parses app path from tool output", () => {
    const text = "✅ App path retrieved successfully: /tmp/Build/MyApp.app";
    expect(parseAppPathFromToolText(text)).toBe("/tmp/Build/MyApp.app");
  });

  it("parses bundle id from tool output", () => {
    expect(parseBundleIdFromToolText("✅ Bundle ID: com.example.myapp")).toBe(
      "com.example.myapp",
    );
  });

  it("parses app path from xcodebuild settings", () => {
    const settings = [
      "BUILT_PRODUCTS_DIR = /tmp/Build/Products/Debug-iphoneos",
      "FULL_PRODUCT_NAME = MyApp.app",
    ].join("\n");
    expect(parseAppPathFromBuildSettings(settings)).toBe(
      "/tmp/Build/Products/Debug-iphoneos/MyApp.app",
    );
  });
});

describe("runPhysicalPipeline", () => {
  it("uses canonical xcodebuildmcp command names", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(toolResult("launch ok"));

    await runPhysicalPipeline(
      physicalContext(),
      nonInteractivePrompts(),
      {
        runTool,
        runRaw: vi.fn(),
      },
    );

    expect(runTool).toHaveBeenNthCalledWith(
      1,
      [
        "device",
        "build",
        "--workspace-path",
        "/repo/App.xcworkspace",
        "--scheme",
        "App",
        "--configuration",
        "Debug",
      ],
      { verbose: false },
    );
    expect(runTool).toHaveBeenNthCalledWith(
      2,
      [
        "device",
        "get-app-path",
        "--workspace-path",
        "/repo/App.xcworkspace",
        "--scheme",
        "App",
        "--platform",
        "iOS",
      ],
      { verbose: false },
    );
    expect(runTool).toHaveBeenNthCalledWith(
      4,
      [
        "device",
        "install",
        "--device-id",
        "DEVICE-1",
        "--app-path",
        "/tmp/Build/Products/Debug-iphoneos/App.app",
      ],
      { verbose: false },
    );
    expect(runTool).toHaveBeenNthCalledWith(
      5,
      ["device", "launch", "--device-id", "DEVICE-1", "--bundle-id", "com.example.app"],
      { verbose: false },
    );
  });

  it("falls back to xcodebuild/plistbuddy when tool parsing does not yield values", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(toolResult("could not parse path"))
      .mockResolvedValueOnce(toolResult("could not parse bundle id"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(toolResult("launch ok"));

    const runRaw = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout:
          "BUILT_PRODUCTS_DIR = /tmp/Build/Products/Debug-iphoneos\nFULL_PRODUCT_NAME = App.app\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout: "com.example.app\n",
        stderr: "",
      });

    await runPhysicalPipeline(
      physicalContext(),
      nonInteractivePrompts(),
      {
        runTool,
        runRaw,
      },
    );

    expect(runTool).toHaveBeenCalledTimes(5);
    expect(runRaw).toHaveBeenCalledTimes(2);
  });

  it("surfaces detailed tool failure output", async () => {
    const runTool = vi.fn().mockResolvedValue({
      ok: false,
      code: 1,
      stdout: "device\n\nUnknown arguments: build-device",
      stderr: "",
      response: {
        text: "device",
        isError: false,
        json: null,
      },
    } satisfies ToolCommandResult);

    await expect(
      runPhysicalPipeline(
        physicalContext(),
        nonInteractivePrompts(),
        {
          runTool,
          runRaw: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      message: "Device build failed.",
      details: expect.arrayContaining([
        "Exit code: 1",
        "Tool response:\ndevice",
        "stdout:\ndevice\n\nUnknown arguments: build-device",
      ]),
    } satisfies Partial<UserFacingError>);
  });

  it("retries install after a locked-device failure", async () => {
    const lockedMessage =
      "Failed to mount image: 0xE80000E2 (kAMDMobileImageMounterDeviceLocked: The device is locked.)";
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(failedToolResult(lockedMessage))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(toolResult("launch ok"));

    const warn = vi.fn();
    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn,
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await runPhysicalPipeline(physicalContext(), prompts, {
      runTool,
      runRaw: vi.fn(),
    });

    expect(runTool).toHaveBeenCalledTimes(6);
    expect(runTool).toHaveBeenNthCalledWith(
      4,
      [
        "device",
        "install",
        "--device-id",
        "DEVICE-1",
        "--app-path",
        "/tmp/Build/Products/Debug-iphoneos/App.app",
      ],
      { verbose: false },
    );
    expect(runTool).toHaveBeenNthCalledWith(
      5,
      [
        "device",
        "install",
        "--device-id",
        "DEVICE-1",
        "--app-path",
        "/tmp/Build/Products/Debug-iphoneos/App.app",
      ],
      { verbose: false },
    );
    expect(warn).toHaveBeenCalledWith("Screenager is locked. Please unlock your device to continue.");
    expect(select).toHaveBeenCalledWith(
      "What would you like to do?",
      [
        { value: "retry", label: "Try again" },
        { value: "cancel", label: "Cancel" },
      ],
      "retry",
    );
  });

  it("cancels install retry when the user chooses cancel", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(
        failedToolResult("The device is locked. 0xE80000E2"),
      );

    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: vi.fn(),
      step: () => undefined,
      select: vi.fn(async () => "cancel"),
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await expect(
      runPhysicalPipeline(physicalContext(), prompts, {
        runTool,
        runRaw: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(UserCancelledError);

    expect(runTool).toHaveBeenCalledTimes(4);
  });

  it("retries launch after a SpringBoard locked-device failure", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to launch app: ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002 (0x2712))\nNSLocalizedFailureReason = Unable to launch com.example.app because the device was not, or could not be, unlocked.\nBSErrorCodeDescription = Locked\nFBSOpenApplicationErrorDomain error 7",
        ),
      )
      .mockResolvedValueOnce(toolResult("launch ok"));

    const warn = vi.fn();
    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn,
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await runPhysicalPipeline(physicalContext(), prompts, {
      runTool,
      runRaw: vi.fn(),
    });

    expect(runTool).toHaveBeenCalledTimes(6);
    expect(runTool).toHaveBeenNthCalledWith(
      5,
      ["device", "launch", "--device-id", "DEVICE-1", "--bundle-id", "com.example.app"],
      { verbose: false },
    );
    expect(runTool).toHaveBeenNthCalledWith(
      6,
      ["device", "launch", "--device-id", "DEVICE-1", "--bundle-id", "com.example.app"],
      { verbose: false },
    );
    expect(warn).toHaveBeenCalledWith("Screenager is locked. Please unlock your device to continue.");
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("retries launch after a CoreDevice disconnect launch failure", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to launch app: ERROR: The device disconnected immediately after connecting. (com.apple.dt.CoreDeviceError error 4000 (0xFA0))",
        ),
      )
      .mockResolvedValueOnce(toolResult("launch ok"));

    const warn = vi.fn();
    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn,
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await runPhysicalPipeline(physicalContext(), prompts, {
      runTool,
      runRaw: vi.fn(),
    });

    expect(runTool).toHaveBeenCalledTimes(6);
    expect(runTool).toHaveBeenNthCalledWith(
      5,
      ["device", "launch", "--device-id", "DEVICE-1", "--bundle-id", "com.example.app"],
      { verbose: false },
    );
    expect(runTool).toHaveBeenNthCalledWith(
      6,
      ["device", "launch", "--device-id", "DEVICE-1", "--bundle-id", "com.example.app"],
      { verbose: false },
    );
    expect(warn).toHaveBeenCalledWith(
      "Screenager disconnected while launching the app. Reconnect it or make sure it stays reachable, then try again.",
    );
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps launch locked failures fatal in non-interactive mode", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to launch app: ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002 (0x2712))\nNSLocalizedFailureReason = Unable to launch com.example.app because the device was not, or could not be, unlocked.\nBSErrorCodeDescription = Locked\nFBSOpenApplicationErrorDomain error 7",
        ),
      );

    await expect(
      runPhysicalPipeline(physicalContext(), nonInteractivePrompts(), {
        runTool,
        runRaw: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: "Physical device is locked. Unlock the device and run the command again.",
      details: expect.arrayContaining([
        "Exit code: 1",
        expect.stringContaining("Tool response:\nFailed to launch app: ERROR: The application failed to launch."),
      ]),
    } satisfies Partial<UserFacingError>);
  });

  it("does not misclassify generic launch failures as locked-device errors", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to launch app: ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002 (0x2712))\nNSLocalizedFailureReason = Unable to launch com.example.app because LaunchServices returned a generic failure.\nFBSOpenApplicationServiceErrorDomain error 1",
        ),
      );

    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: vi.fn(),
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await expect(
      runPhysicalPipeline(physicalContext(), prompts, {
        runTool,
        runRaw: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: "Failed to launch app on physical device.",
    } satisfies Partial<UserFacingError>);

    expect(select).not.toHaveBeenCalled();
  });

  it("keeps locked-device failures fatal in non-interactive mode", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(
        failedToolResult("The device is locked. 0xE80000E2"),
      );

    await expect(
      runPhysicalPipeline(physicalContext(), nonInteractivePrompts(), {
        runTool,
        runRaw: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: "Physical device is locked. Unlock the device and run the command again.",
      details: expect.arrayContaining([
        "Exit code: 1",
        "Tool response:\nThe device is locked. 0xE80000E2",
      ]),
    } satisfies Partial<UserFacingError>);
  });

  it("install 1011 connectivity failures prompt retry in interactive mode", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to install app: ERROR: CoreDeviceService was unable to locate a device matching the requested device identifier. (DeviceIdentifier: ecid_2845759774425116) (com.apple.dt.CoreDeviceError error 1011 (0x3F3))\nDeviceIdentifier = ecid_2845759774425116",
        ),
      )
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(toolResult("launch ok"));

    const warn = vi.fn();
    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn,
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await runPhysicalPipeline(
      physicalContext({
        state: "Paired (Not Connected)",
        connectionState: "paired_disconnected",
      }),
      prompts,
      {
        runTool,
        runRaw: vi.fn(),
      },
    );

    expect(runTool).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledWith(
      "Screenager is not reachable from this Mac right now. Unlock it, put it on the same Wi-Fi network as your Mac or connect it with USB, then try again.",
    );
    expect(select).toHaveBeenCalledWith(
      "What would you like to do?",
      [
        { value: "retry", label: "Try again" },
        { value: "cancel", label: "Cancel" },
      ],
      "retry",
    );
  });

  it("install 1011 connectivity failures cancel cleanly", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to install app: ERROR: CoreDeviceService was unable to locate a device matching the requested device identifier. (DeviceIdentifier: ecid_2845759774425116) (com.apple.dt.CoreDeviceError error 1011 (0x3F3))",
        ),
      );

    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: vi.fn(),
      step: () => undefined,
      select: vi.fn(async () => "cancel"),
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await expect(
      runPhysicalPipeline(
        physicalContext({
          state: "Paired (Not Connected)",
          connectionState: "paired_disconnected",
        }),
        prompts,
        {
          runTool,
          runRaw: vi.fn(),
        },
      ),
    ).rejects.toBeInstanceOf(UserCancelledError);
  });

  it("install 1011 connectivity failures are plain-English in non-interactive mode", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to install app: ERROR: CoreDeviceService was unable to locate a device matching the requested device identifier. (DeviceIdentifier: ecid_2845759774425116) (com.apple.dt.CoreDeviceError error 1011 (0x3F3))\nDeviceIdentifier = ecid_2845759774425116",
        ),
      );

    await expect(
      runPhysicalPipeline(
        physicalContext({
          state: "Paired (Not Connected)",
          connectionState: "paired_disconnected",
        }),
        nonInteractivePrompts(),
        {
          runTool,
          runRaw: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      message:
        "Screenager is not reachable from this Mac right now. Unlock it, put it on the same Wi-Fi network as your Mac or connect it with USB, then run simplybuild again.",
      details: expect.arrayContaining([
        "Your Mac can see the phone, but it cannot reach it well enough to install the app.",
        "Make sure the phone is unlocked and either on the same Wi-Fi network as your Mac or connected with USB.",
        "Then try again.",
        "Exit code: 1",
        expect.stringContaining("Tool response:\nFailed to install app: ERROR: CoreDeviceService was unable to locate a device matching the requested device identifier."),
      ]),
    } satisfies Partial<UserFacingError>);
  });

  it("install 4000 connectivity failures prompt retry in interactive mode", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(
        failedToolResult(
          "Failed to install app: ERROR: A connection to this device could not be established. (com.apple.dt.CoreDeviceError error 4000 (0xFA0))\nTransport error: The peer is no longer reachable",
        ),
      )
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(toolResult("launch ok"));

    const warn = vi.fn();
    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn,
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await runPhysicalPipeline(
      physicalContext({
        state: "Paired (Not Connected)",
        connectionState: "paired_disconnected",
      }),
      prompts,
      {
        runTool,
        runRaw: vi.fn(),
      },
    );

    expect(runTool).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledWith(
      "Screenager is not reachable from this Mac right now. Unlock it, put it on the same Wi-Fi network as your Mac or connect it with USB, then try again.",
    );
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-locked install failures", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(failedToolResult("Developer disk image missing"));

    const select = vi.fn(async () => "retry");
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: vi.fn(),
      step: () => undefined,
      select,
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    await expect(
      runPhysicalPipeline(physicalContext(), prompts, {
        runTool,
        runRaw: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: "Failed to install app on physical device.",
    } satisfies Partial<UserFacingError>);

    expect(select).not.toHaveBeenCalled();
  });
});

describe("runSimulatorPipeline", () => {
  it("uses the canonical build-and-run simulator command", async () => {
    const runTool = vi.fn().mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "{}",
      stderr: "",
      response: {
        text: "ok",
        isError: false,
        json: {},
      },
    } satisfies ToolCommandResult);

    const prompts: PromptApi = {
      interactive: false,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      step: () => undefined,
      select: async () => {
        throw new Error("not used");
      },
      confirm: async () => {
        throw new Error("not used");
      },
      text: async () => {
        throw new Error("not used");
      },
      stage: async (_message, task) => task(),
    };

    await runSimulatorPipeline(
      {
        container: {
          kind: "workspace",
          path: "/repo/App.xcworkspace",
          name: "App",
        },
        scheme: "App",
        target: {
          kind: "simulator",
          id: "SIM-1",
          name: "iPhone 16",
          os: "iOS 26.0",
          state: "Booted",
          isBooted: true,
        },
        verbose: false,
      },
      prompts,
      {
        runTool,
        runRaw: vi.fn(),
      },
    );

    expect(runTool).toHaveBeenCalledWith(
      [
        "simulator",
        "build-and-run",
        "--workspace-path",
        "/repo/App.xcworkspace",
        "--scheme",
        "App",
        "--simulator-id",
        "SIM-1",
        "--configuration",
        "Debug",
      ],
      { verbose: false },
    );
  });
});

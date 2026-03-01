import { describe, expect, it, vi } from "vitest";
import {
  parseAppPathFromBuildSettings,
  parseAppPathFromToolText,
  parseBundleIdFromToolText,
  runPhysicalPipeline,
  runSimulatorPipeline,
} from "../src/runner/pipelines.js";
import type { PromptApi } from "../src/ui/prompts.js";
import type { ToolCommandResult } from "../src/runner/xcodebuildmcpRunner.js";
import { UserFacingError } from "../src/types.js";

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
    const toolResult = (text: string): ToolCommandResult => ({
      ok: true,
      code: 0,
      stdout: "{}",
      stderr: "",
      response: {
        text,
        isError: false,
        json: {},
      },
    });

    const runTool = vi
      .fn()
      .mockResolvedValueOnce(toolResult("build ok"))
      .mockResolvedValueOnce(
        toolResult("App path retrieved successfully: /tmp/Build/Products/Debug-iphoneos/App.app"),
      )
      .mockResolvedValueOnce(toolResult("Bundle ID: com.example.app"))
      .mockResolvedValueOnce(toolResult("install ok"))
      .mockResolvedValueOnce(toolResult("launch ok"));

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

    await runPhysicalPipeline(
      {
        container: {
          kind: "workspace",
          path: "/repo/App.xcworkspace",
          name: "App",
        },
        scheme: "App",
        target: {
          kind: "physical",
          id: "DEVICE-1",
          name: "Screenager",
          os: "iOS 26.2",
          state: "Available",
        },
        verbose: false,
      },
      prompts,
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
    const toolResult = (text: string): ToolCommandResult => ({
      ok: true,
      code: 0,
      stdout: "{}",
      stderr: "",
      response: {
        text,
        isError: false,
        json: {},
      },
    });

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

    await runPhysicalPipeline(
      {
        container: {
          kind: "workspace",
          path: "/repo/App.xcworkspace",
          name: "App",
        },
        scheme: "App",
        target: {
          kind: "physical",
          id: "DEVICE-1",
          name: "Screenager",
          os: "iOS 26.2",
          state: "Available",
        },
        verbose: false,
      },
      prompts,
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

    await expect(
      runPhysicalPipeline(
        {
          container: {
            kind: "workspace",
            path: "/repo/App.xcworkspace",
            name: "App",
          },
          scheme: "App",
          target: {
            kind: "physical",
            id: "DEVICE-1",
            name: "Screenager",
            os: "iOS 26.2",
            state: "Available",
          },
          verbose: false,
        },
        prompts,
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

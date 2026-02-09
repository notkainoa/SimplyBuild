import { describe, expect, it, vi } from "vitest";
import {
  parseAppPathFromBuildSettings,
  parseAppPathFromToolText,
  parseBundleIdFromToolText,
  runPhysicalPipeline,
} from "../src/runner/pipelines.js";
import type { PromptApi } from "../src/ui/prompts.js";
import type { ToolCommandResult } from "../src/runner/xcodebuildmcpRunner.js";

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
});

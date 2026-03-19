import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runner/commandRunner.js", () => ({
  runCommand: vi.fn(),
}));

import { discoverPhysicalDevices, discoverSimulators } from "../src/discovery/targets.js";
import { runCommand } from "../src/runner/commandRunner.js";

const runCommandMock = vi.mocked(runCommand);

afterEach(() => {
  vi.clearAllMocks();
});

describe("target discovery platform filtering", () => {
  it("keeps only iOS simulator runtimes", async () => {
    runCommandMock.mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
            {
              name: "iPhone 16",
              udid: "SIM-IOS",
              state: "Booted",
              isAvailable: true,
            },
          ],
          "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [
            {
              name: "Apple TV",
              udid: "SIM-TV",
              state: "Shutdown",
              isAvailable: true,
            },
          ],
        },
      }),
      stderr: "",
    });

    const targets = await discoverSimulators();
    expect(targets.map((target) => target.id)).toEqual(["SIM-IOS"]);
  });

  it("keeps only iOS physical devices when platform identifiers are present", async () => {
    runCommandMock.mockImplementationOnce(async (_command, args) => {
      const outputFlagIndex = args.indexOf("--json-output");
      const outputPath = args[outputFlagIndex + 1];
      if (!outputPath) {
        throw new Error("Expected --json-output path");
      }

      await writeFile(
        outputPath,
        JSON.stringify({
          result: {
            devices: [
              {
                identifier: "DEVICE-IOS",
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "connected",
                },
                deviceProperties: {
                  name: "Personal iPhone",
                  osVersionNumber: "18.2",
                  platformIdentifier: "com.apple.platform.iphoneos",
                },
              },
              {
                identifier: "DEVICE-TV",
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "connected",
                },
                deviceProperties: {
                  name: "Apple TV",
                  osVersionNumber: "18.2",
                  platformIdentifier: "com.apple.platform.appletvos",
                },
              },
            ],
          },
        }),
        "utf8",
      );

      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const targets = await discoverPhysicalDevices();
    expect(targets.map((target) => target.id)).toEqual(["DEVICE-IOS"]);
    expect(targets[0]).toMatchObject({
      state: "Available",
      connectionState: "connected",
    });
  });

  it("labels paired disconnected devices as Paired (Not Connected) and keeps them", async () => {
    runCommandMock.mockImplementationOnce(async (_command, args) => {
      const outputFlagIndex = args.indexOf("--json-output");
      const outputPath = args[outputFlagIndex + 1];
      if (!outputPath) {
        throw new Error("Expected --json-output path");
      }

      await writeFile(
        outputPath,
        JSON.stringify({
          result: {
            devices: [
              {
                identifier: "DEVICE-IOS",
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "disconnected",
                },
                deviceProperties: {
                  name: "Screenager",
                  osVersionNumber: "26.4",
                  platformIdentifier: "com.apple.platform.iphoneos",
                },
              },
            ],
          },
        }),
        "utf8",
      );

      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const targets = await discoverPhysicalDevices();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: "DEVICE-IOS",
      state: "Paired (Not Connected)",
      connectionState: "paired_disconnected",
    });
  });

  it("uses hardware UDID when identifier is ecid-style", async () => {
    runCommandMock.mockImplementationOnce(async (_command, args) => {
      const outputFlagIndex = args.indexOf("--json-output");
      const outputPath = args[outputFlagIndex + 1];
      if (!outputPath) {
        throw new Error("Expected --json-output path");
      }

      await writeFile(
        outputPath,
        JSON.stringify({
          result: {
            devices: [
              {
                identifier: "ecid_2845759774425116",
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "connected",
                },
                deviceProperties: {
                  name: "Screenager",
                  osVersionNumber: "26.4",
                  platformIdentifier: "com.apple.platform.iphoneos",
                },
                hardwareProperties: {
                  udid: "00008140-000A1C341478801C",
                },
              },
            ],
          },
        }),
        "utf8",
      );

      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const targets = await discoverPhysicalDevices();
    expect(targets.map((target) => target.id)).toEqual(["00008140-000A1C341478801C"]);
  });

  it("keeps identifier when it is already deployable", async () => {
    runCommandMock.mockImplementationOnce(async (_command, args) => {
      const outputFlagIndex = args.indexOf("--json-output");
      const outputPath = args[outputFlagIndex + 1];
      if (!outputPath) {
        throw new Error("Expected --json-output path");
      }

      await writeFile(
        outputPath,
        JSON.stringify({
          result: {
            devices: [
              {
                identifier: "DEVICE-IOS",
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "connected",
                },
                deviceProperties: {
                  name: "Screenager",
                  osVersionNumber: "26.4",
                  platformIdentifier: "com.apple.platform.iphoneos",
                },
                hardwareProperties: {
                  udid: "00008140-000A1C341478801C",
                },
              },
            ],
          },
        }),
        "utf8",
      );

      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const targets = await discoverPhysicalDevices();
    expect(targets.map((target) => target.id)).toEqual(["DEVICE-IOS"]);
  });

  it("falls back to udid when identifier is missing", async () => {
    runCommandMock.mockImplementationOnce(async (_command, args) => {
      const outputFlagIndex = args.indexOf("--json-output");
      const outputPath = args[outputFlagIndex + 1];
      if (!outputPath) {
        throw new Error("Expected --json-output path");
      }

      await writeFile(
        outputPath,
        JSON.stringify({
          result: {
            devices: [
              {
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "connected",
                },
                deviceProperties: {
                  name: "Screenager",
                  osVersionNumber: "26.4",
                  platformIdentifier: "com.apple.platform.iphoneos",
                },
                hardwareProperties: {
                  udid: "00008140-000A1C341478801C",
                },
              },
            ],
          },
        }),
        "utf8",
      );

      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const targets = await discoverPhysicalDevices();
    expect(targets.map((target) => target.id)).toEqual(["00008140-000A1C341478801C"]);
  });

  it("skips physical devices with neither identifier nor udid", async () => {
    runCommandMock.mockImplementationOnce(async (_command, args) => {
      const outputFlagIndex = args.indexOf("--json-output");
      const outputPath = args[outputFlagIndex + 1];
      if (!outputPath) {
        throw new Error("Expected --json-output path");
      }

      await writeFile(
        outputPath,
        JSON.stringify({
          result: {
            devices: [
              {
                visibilityClass: "Physical",
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: "connected",
                },
                deviceProperties: {
                  name: "Screenager",
                  osVersionNumber: "26.4",
                  platformIdentifier: "com.apple.platform.iphoneos",
                },
              },
            ],
          },
        }),
        "utf8",
      );

      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
      };
    });

    const targets = await discoverPhysicalDevices();
    expect(targets).toEqual([]);
  });
});

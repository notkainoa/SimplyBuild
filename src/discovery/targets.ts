import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TargetCandidate } from "../types.js";
import { runCommand } from "../runner/commandRunner.js";

interface DeviceCtlDevice {
  identifier?: string;
  visibilityClass?: string;
  connectionProperties?: {
    pairingState?: string;
    tunnelState?: string;
  };
  deviceProperties?: {
    name?: string;
    osVersionNumber?: string;
    platformIdentifier?: string;
  };
}

function parseRuntimeLabel(runtimeKey: string): string {
  const runtime = runtimeKey.split("SimRuntime.").pop() ?? runtimeKey;
  const parts = runtime.split("-");
  if (parts.length < 2) {
    return runtimeKey;
  }
  const platform = parts[0];
  const version = parts.slice(1).join(".");
  return `${platform} ${version}`;
}

function normalizeState(pairingState?: string, tunnelState?: string): string {
  if (pairingState !== "paired") {
    return "Unpaired";
  }
  if (tunnelState === "connected") {
    return "Available";
  }
  return "Available (WiFi)";
}

export async function discoverPhysicalDevices(): Promise<TargetCandidate[]> {
  const outputPath = path.join(os.tmpdir(), `simplybuild-devicectl-${Date.now()}.json`);
  const result = await runCommand("xcrun", [
    "devicectl",
    "list",
    "devices",
    "--json-output",
    outputPath,
  ]);

  if (!result.ok) {
    return [];
  }

  try {
    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as {
      result?: {
        devices?: DeviceCtlDevice[];
      };
    };

    const items = parsed.result?.devices;
    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .filter((item) => item.visibilityClass !== "Simulator")
      .filter((item) => typeof item.identifier === "string")
      .map((item) => {
        const state = normalizeState(
          item.connectionProperties?.pairingState,
          item.connectionProperties?.tunnelState,
        );
        return {
          kind: "physical" as const,
          id: item.identifier ?? "",
          name: item.deviceProperties?.name?.trim() || "Unknown Device",
          os:
            item.deviceProperties?.osVersionNumber ||
            item.deviceProperties?.platformIdentifier ||
            "iOS",
          state,
          isBooted: false,
        };
      })
      .filter((item) => item.state.startsWith("Available"))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

export async function discoverSimulators(): Promise<TargetCandidate[]> {
  const result = await runCommand("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  if (!result.ok) {
    return [];
  }

  let parsed: { devices?: Record<string, Array<Record<string, unknown>>> };
  try {
    parsed = JSON.parse(result.stdout) as {
      devices?: Record<string, Array<Record<string, unknown>>>;
    };
  } catch {
    return [];
  }

  const devices = parsed.devices ?? {};
  const targets: TargetCandidate[] = [];

  for (const [runtime, simulatorList] of Object.entries(devices)) {
    for (const item of simulatorList) {
      const name = typeof item.name === "string" ? item.name : undefined;
      const id = typeof item.udid === "string" ? item.udid : undefined;
      const state = typeof item.state === "string" ? item.state : "Unknown";
      const isAvailable = item.isAvailable === true;

      if (!name || !id || !isAvailable) {
        continue;
      }

      targets.push({
        kind: "simulator",
        id,
        name,
        os: parseRuntimeLabel(runtime),
        state,
        isBooted: state === "Booted",
      });
    }
  }

  return targets.sort((a, b) => {
    if (a.isBooted !== b.isBooted) {
      return a.isBooted ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export async function discoverTargets(): Promise<TargetCandidate[]> {
  const [physical, simulators] = await Promise.all([
    discoverPhysicalDevices(),
    discoverSimulators(),
  ]);

  return [...physical, ...simulators];
}

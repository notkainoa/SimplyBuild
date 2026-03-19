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
  hardwareProperties?: {
    udid?: string;
  };
}

type PhysicalConnectionState = NonNullable<TargetCandidate["connectionState"]>;

export function isLikelyIosPhysicalPlatform(platformIdentifier?: string): boolean {
  if (!platformIdentifier) {
    return true;
  }

  const normalized = platformIdentifier.toLowerCase();
  return (
    normalized.includes("iphoneos") ||
    normalized === "ios" ||
    normalized.endsWith(".ios")
  );
}

export function isIosSimulatorRuntime(runtimeKey: string): boolean {
  const runtime = runtimeKey.split("SimRuntime.").pop() ?? runtimeKey;
  return runtime.toLowerCase().startsWith("ios-");
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

function resolvePhysicalConnectionState(
  pairingState?: string,
  tunnelState?: string,
): PhysicalConnectionState {
  if (pairingState !== "paired") {
    return "unpaired";
  }
  if (tunnelState === "connected") {
    return "connected";
  }
  if (tunnelState === "disconnected" || tunnelState === "unavailable") {
    return "paired_disconnected";
  }
  return "unknown";
}

function formatPhysicalState(connectionState: PhysicalConnectionState): string {
  switch (connectionState) {
    case "connected":
      return "Available";
    case "paired_disconnected":
      return "Paired (Not Connected)";
    case "unpaired":
      return "Unpaired";
    default:
      return "Unknown";
  }
}

function resolvePhysicalDeviceId(item: DeviceCtlDevice): string | undefined {
  const identifier = item.identifier?.trim();
  const udid = item.hardwareProperties?.udid?.trim();

  if (identifier?.toLowerCase().startsWith("ecid_") && udid) {
    return udid;
  }

  if (identifier) {
    return identifier;
  }

  if (udid) {
    return udid;
  }

  return undefined;
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
      .filter((item) => isLikelyIosPhysicalPlatform(item.deviceProperties?.platformIdentifier))
      .flatMap((item) => {
        const id = resolvePhysicalDeviceId(item);
        if (!id) {
          return [];
        }

        const connectionState = resolvePhysicalConnectionState(
          item.connectionProperties?.pairingState,
          item.connectionProperties?.tunnelState,
        );
        const state = formatPhysicalState(connectionState);
        return [{
          kind: "physical" as const,
          id,
          name: item.deviceProperties?.name?.trim() || "Unknown Device",
          os:
            item.deviceProperties?.osVersionNumber ||
            item.deviceProperties?.platformIdentifier ||
            "iOS",
          state,
          connectionState,
          isBooted: false,
        }];
      })
      .filter((item) => item.connectionState !== "unpaired")
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
    if (!isIosSimulatorRuntime(runtime)) {
      continue;
    }

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

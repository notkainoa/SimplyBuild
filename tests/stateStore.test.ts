import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateStore } from "../src/state/store.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0, dirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("stateStore", () => {
  it("backs up corrupt state file and recovers with empty state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simplybuild-state-"));
    dirs.push(root);

    const statePath = path.join(root, "state.json");
    await writeFile(statePath, "{ bad json", "utf8");

    const store = createStateStore(statePath);
    const memory = await store.getProjectMemory("/tmp/project");
    expect(memory).toBeUndefined();

    const files = await readdir(root);
    expect(files.some((file) => file.startsWith("state.json.corrupt-"))).toBe(true);
  });

  it("persists project context and approval list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simplybuild-state-"));
    dirs.push(root);

    const statePath = path.join(root, "state.json");
    const store = createStateStore(statePath);

    await store.setProjectContext("/repo/app", {
      containerPath: "/repo/app/App.xcworkspace",
      containerKind: "workspace",
      scheme: "App",
      target: {
        kind: "physical",
        id: "DEVICE-1",
        name: "Screenager",
      },
    });

    await store.markPhysicalDeviceApproved("/repo/app", "DEVICE-1");

    const saved = JSON.parse(await readFile(statePath, "utf8")) as {
      projects: Record<string, { approvedPhysicalDeviceIds: string[]; lastScheme?: string }>;
    };

    expect(saved.projects["/repo/app"].lastScheme).toBe("App");
    expect(saved.projects["/repo/app"].approvedPhysicalDeviceIds).toContain("DEVICE-1");
    await expect(store.isPhysicalDeviceApproved("/repo/app", "DEVICE-1")).resolves.toBe(true);
  });
});

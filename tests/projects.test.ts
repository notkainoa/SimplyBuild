import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjects } from "../src/discovery/projects.js";

const createdDirs: string[] = [];

afterEach(async () => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

describe("discoverProjects", () => {
  it("finds xcodeproj and xcworkspace while skipping ignored folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simplybuild-projects-"));
    createdDirs.push(root);

    await mkdir(path.join(root, "App.xcodeproj"));
    await mkdir(path.join(root, "Workspace.xcworkspace"));
    await mkdir(path.join(root, "nested", "Feature.xcodeproj"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "IgnoreMe.xcodeproj"), { recursive: true });

    const projects = await discoverProjects(root);

    const paths = projects.map((p) => path.relative(root, p.path));
    expect(paths).toContain("App.xcodeproj");
    expect(paths).toContain("Workspace.xcworkspace");
    expect(paths).toContain(path.join("nested", "Feature.xcodeproj"));
    expect(paths).not.toContain(path.join("node_modules", "IgnoreMe.xcodeproj"));
  });
});

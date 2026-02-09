import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectCandidate } from "../types.js";

const SKIP_DIRS = new Set([".git", "node_modules", "Pods", "DerivedData", "build"]);

async function scanDirectory(root: string, current: string, acc: ProjectCandidate[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath);
    if (relative.startsWith("..")) {
      continue;
    }

    if (entry.name.endsWith(".xcworkspace")) {
      acc.push({
        kind: "workspace",
        path: fullPath,
        name: entry.name.replace(/\.xcworkspace$/, ""),
      });
      continue;
    }

    if (entry.name.endsWith(".xcodeproj")) {
      acc.push({
        kind: "project",
        path: fullPath,
        name: entry.name.replace(/\.xcodeproj$/, ""),
      });
      continue;
    }

    await scanDirectory(root, fullPath, acc);
  }
}

export async function discoverProjects(scanRoot: string): Promise<ProjectCandidate[]> {
  const root = path.resolve(scanRoot);
  const results: ProjectCandidate[] = [];

  await scanDirectory(root, root, results);

  return results.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "workspace" ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });
}

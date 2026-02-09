import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ContainerKind,
  type ProjectMemory,
  type StateFile,
  type TargetCandidate,
} from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function defaultStateDir(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState && xdgState.trim().length > 0) {
    return path.resolve(xdgState, "simplybuild");
  }
  return path.resolve(os.homedir(), ".local", "state", "simplybuild");
}

function createEmptyState(): StateFile {
  return {
    version: 1,
    projects: {},
  };
}

function isProjectMemory(value: unknown): value is ProjectMemory {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<ProjectMemory>;
  return (
    typeof item.updatedAt === "string" &&
    Array.isArray(item.approvedPhysicalDeviceIds) &&
    item.approvedPhysicalDeviceIds.every((id) => typeof id === "string")
  );
}

function isStateFile(value: unknown): value is StateFile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<StateFile>;
  if (state.version !== 1 || !state.projects || typeof state.projects !== "object") {
    return false;
  }

  return Object.values(state.projects).every((entry) => isProjectMemory(entry));
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export interface StateStore {
  readonly statePath: string;
  getProjectMemory(projectKey: string): Promise<ProjectMemory | undefined>;
  setProjectContext(
    projectKey: string,
    payload: {
      containerPath: string;
      containerKind: ContainerKind;
      scheme: string;
      target: Pick<TargetCandidate, "kind" | "id" | "name">;
    },
  ): Promise<void>;
  markPhysicalDeviceApproved(projectKey: string, deviceId: string): Promise<void>;
  isPhysicalDeviceApproved(projectKey: string, deviceId: string): Promise<boolean>;
}

export function createStateStore(customStatePath?: string): StateStore {
  const statePath = customStatePath ?? path.join(defaultStateDir(), "state.json");
  let cache: StateFile | null = null;

  const load = async (): Promise<StateFile> => {
    if (cache) {
      return cache;
    }

    await ensureDir(path.dirname(statePath));

    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isStateFile(parsed)) {
        cache = parsed;
        return cache;
      }

      const backup = `${statePath}.corrupt-${Date.now()}`;
      await fs.rename(statePath, backup).catch(() => undefined);
      cache = createEmptyState();
      return cache;
    } catch {
      const backup = `${statePath}.corrupt-${Date.now()}`;
      await fs.rename(statePath, backup).catch(() => undefined);
      cache = createEmptyState();
      return cache;
    }
  };

  const save = async (state: StateFile): Promise<void> => {
    await ensureDir(path.dirname(statePath));
    const tempPath = `${statePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, statePath);
  };

  const getOrCreateProject = (state: StateFile, projectKey: string): ProjectMemory => {
    const existing = state.projects[projectKey];
    if (existing) {
      return existing;
    }

    const created: ProjectMemory = {
      approvedPhysicalDeviceIds: [],
      updatedAt: nowIso(),
    };
    state.projects[projectKey] = created;
    return created;
  };

  return {
    statePath,

    async getProjectMemory(projectKey: string): Promise<ProjectMemory | undefined> {
      const state = await load();
      return state.projects[projectKey];
    },

    async setProjectContext(
      projectKey: string,
      payload: {
        containerPath: string;
        containerKind: ContainerKind;
        scheme: string;
        target: Pick<TargetCandidate, "kind" | "id" | "name">;
      },
    ): Promise<void> {
      const state = await load();
      const project = getOrCreateProject(state, projectKey);
      project.lastSelectedContainerPath = payload.containerPath;
      project.containerKind = payload.containerKind;
      project.lastScheme = payload.scheme;
      project.lastTarget = {
        kind: payload.target.kind,
        id: payload.target.id,
        name: payload.target.name,
      };
      project.updatedAt = nowIso();
      await save(state);
    },

    async markPhysicalDeviceApproved(projectKey: string, deviceId: string): Promise<void> {
      const state = await load();
      const project = getOrCreateProject(state, projectKey);
      if (!project.approvedPhysicalDeviceIds.includes(deviceId)) {
        project.approvedPhysicalDeviceIds.push(deviceId);
      }
      project.updatedAt = nowIso();
      await save(state);
    },

    async isPhysicalDeviceApproved(projectKey: string, deviceId: string): Promise<boolean> {
      const state = await load();
      const project = state.projects[projectKey];
      if (!project) {
        return false;
      }
      return project.approvedPhysicalDeviceIds.includes(deviceId);
    },
  };
}

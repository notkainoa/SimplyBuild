import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSimplyBuild } from "../src/app/runSimplyBuild.js";
import { UserFacingError } from "../src/types.js";
import type { PromptApi } from "../src/ui/prompts.js";
import type { StateStore } from "../src/state/store.js";

function nonInteractivePrompts(): PromptApi {
  return {
    interactive: false,
    intro: () => undefined,
    outro: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    step: () => undefined,
    select: async () => {
      throw new Error("select should not be called");
    },
    confirm: async () => {
      throw new Error("confirm should not be called");
    },
    text: async () => {
      throw new Error("text should not be called");
    },
    stage: async (_message, task) => task(),
  };
}

function createRecordingPrompts(options?: {
  interactive?: boolean;
  confirm?: (message: string, initialValue?: boolean) => Promise<boolean>;
  select?: <T>(message: string, options: Array<{ value: T }>, initialValue?: T) => Promise<T>;
  text?: (message: string, initialValue?: string) => Promise<string>;
}) {
  const stageCalls: Array<{
    message: string;
    success?: string;
    error?: string;
  }> = [];

  const prompts: PromptApi = {
    interactive: options?.interactive ?? true,
    intro: () => undefined,
    outro: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    step: () => undefined,
    select: async (message, promptOptions, initialValue) => {
      if (options?.select) {
        return options.select(message, promptOptions as Array<{ value: unknown }>, initialValue);
      }
      return (initialValue as string | undefined) ?? (promptOptions[0]?.value as string);
    },
    confirm: async (message, initialValue) => {
      if (options?.confirm) {
        return options.confirm(message, initialValue);
      }
      return true;
    },
    text: async (message, initialValue) => {
      if (options?.text) {
        return options.text(message, initialValue);
      }
      return initialValue?.trim() || "manual-value";
    },
    stage: async (message, task, labels) => {
      const result = await task();
      stageCalls.push({
        message,
        success: labels?.success,
        error: labels?.error,
      });
      return result;
    },
  };

  return {
    prompts,
    stageCalls,
  };
}

const noopStateStore: StateStore = {
  statePath: "/tmp/state.json",
  getProjectMemory: async () => undefined,
  setProjectContext: async () => undefined,
  markPhysicalDeviceApproved: async () => undefined,
  isPhysicalDeviceApproved: async () => false,
};

describe("runSimplyBuild non-interactive behavior", () => {
  it("fails fast when interactive target selection would be required", async () => {
    const ensureReady = vi.fn(async () => undefined);
    await expect(
      runSimplyBuild(
        {
          listDevices: false,
          listProjects: false,
          verbose: false,
          help: false,
        },
        {
          prompts: nonInteractivePrompts(),
          ensureXcodebuildmcpReady: ensureReady,
        },
      ),
    ).rejects.toBeInstanceOf(UserFacingError);
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });

  it("fails when query requires disambiguation in non-interactive mode", async () => {
    const ensureReady = vi.fn(async () => undefined);
    await expect(
      runSimplyBuild(
        {
          query: "iphone",
          listDevices: false,
          listProjects: false,
          verbose: false,
          help: false,
        },
        {
          prompts: nonInteractivePrompts(),
          stateStore: noopStateStore,
          ensureXcodebuildmcpReady: ensureReady,
          discoverProjects: async () => [
            { kind: "workspace", path: "/repo/App.xcworkspace", name: "App" },
          ],
          discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
          discoverTargets: async () => [
            {
              kind: "simulator",
              id: "SIM-1",
              name: "iPhone 15",
              os: "iOS 26.0",
              state: "Shutdown",
            },
            {
              kind: "simulator",
              id: "SIM-2",
              name: "iPhone 16",
              os: "iOS 26.0",
              state: "Shutdown",
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(UserFacingError);
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });
});

describe("runSimplyBuild state memory keys", () => {
  it("stores project context using the selected container path key", async () => {
    const getProjectMemory = vi.fn(async () => undefined);
    const setProjectContext = vi.fn(async () => undefined);
    const runSimulator = vi.fn(async () => undefined);
    const ensureReady = vi.fn(async () => undefined);

    const store: StateStore = {
      statePath: "/tmp/state.json",
      getProjectMemory,
      setProjectContext,
      markPhysicalDeviceApproved: async () => undefined,
      isPhysicalDeviceApproved: async () => false,
    };

    const containerPath = "/repo/apps/App.xcworkspace";
    await runSimplyBuild(
      {
        query: "screenager",
        listDevices: false,
        listProjects: false,
        verbose: false,
        help: false,
      },
      {
        prompts: nonInteractivePrompts(),
        stateStore: store,
        ensureXcodebuildmcpReady: ensureReady,
        discoverProjects: async () => [{ kind: "workspace", path: containerPath, name: "App" }],
        discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
        discoverTargets: async () => [
          {
            kind: "simulator",
            id: "SIM-1",
            name: "Screenager",
            os: "iOS 26.0",
            state: "Booted",
            isBooted: true,
          },
        ],
        runSimulatorPipeline: runSimulator,
      },
    );

    const expectedProjectKey = path.resolve(containerPath);
    expect(getProjectMemory).toHaveBeenCalledWith(expectedProjectKey);
    expect(setProjectContext).toHaveBeenCalledWith(
      expectedProjectKey,
      expect.objectContaining({
        containerPath,
        containerKind: "workspace",
        scheme: "App",
      }),
    );
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });

  it("preselects the most recently used container from container-scoped memory", async () => {
    let rememberedContainer: string | undefined;
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      step: () => undefined,
      select: async (message, options, initialValue) => {
        if (message === "Select project/workspace") {
          rememberedContainer = initialValue as string | undefined;
          return (initialValue as string | undefined) ?? (options[0]?.value as string);
        }
        throw new Error(`Unexpected select prompt: ${message}`);
      },
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    const firstContainer = "/repo/apps/First.xcworkspace";
    const secondContainer = "/repo/apps/Second.xcworkspace";
    const firstKey = path.resolve(firstContainer);
    const secondKey = path.resolve(secondContainer);
    const getProjectMemory = vi.fn(async (projectKey: string) => {
      if (projectKey === firstKey) {
        return {
          lastSelectedContainerPath: firstContainer,
          approvedPhysicalDeviceIds: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }

      if (projectKey === secondKey) {
        return {
          lastSelectedContainerPath: secondContainer,
          approvedPhysicalDeviceIds: [],
          updatedAt: "2026-01-02T00:00:00.000Z",
        };
      }

      return undefined;
    });

    const runSimulator = vi.fn(async () => undefined);
    const ensureReady = vi.fn(async () => undefined);
    await runSimplyBuild(
      {
        query: "screenager",
        listDevices: false,
        listProjects: false,
        verbose: false,
        help: false,
      },
      {
        cwd: "/repo/apps/subdir",
        prompts,
        ensureXcodebuildmcpReady: ensureReady,
        stateStore: {
          statePath: "/tmp/state.json",
          getProjectMemory,
          setProjectContext: async () => undefined,
          markPhysicalDeviceApproved: async () => undefined,
          isPhysicalDeviceApproved: async () => false,
        },
        discoverProjects: async () => [
          { kind: "workspace", path: firstContainer, name: "First" },
          { kind: "workspace", path: secondContainer, name: "Second" },
        ],
        discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
        discoverTargets: async () => [
          {
            kind: "simulator",
            id: "SIM-1",
            name: "Screenager",
            os: "iOS 26.0",
            state: "Booted",
            isBooted: true,
          },
        ],
        runSimulatorPipeline: runSimulator,
      },
    );

    expect(rememberedContainer).toBe(secondContainer);
    expect(runSimulator).toHaveBeenCalledWith(
      expect.objectContaining({
        container: expect.objectContaining({
          path: secondContainer,
        }),
      }),
      prompts,
    );
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });
});

describe("runSimplyBuild prerequisite gate", () => {
  it("runs prerequisite gate for list-projects mode", async () => {
    const ensureReady = vi.fn(async () => undefined);

    await runSimplyBuild(
      {
        listDevices: false,
        listProjects: true,
        verbose: false,
        help: false,
      },
      {
        prompts: nonInteractivePrompts(),
        ensureXcodebuildmcpReady: ensureReady,
        discoverProjects: async () => [],
      },
    );

    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }), false);
  });

  it("runs prerequisite gate for list-devices mode", async () => {
    const ensureReady = vi.fn(async () => undefined);

    await runSimplyBuild(
      {
        listDevices: true,
        listProjects: false,
        verbose: true,
        help: false,
      },
      {
        prompts: nonInteractivePrompts(),
        ensureXcodebuildmcpReady: ensureReady,
        discoverTargets: async () => [],
      },
    );

    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }), true);
  });

  it("stops early when prerequisite gate fails", async () => {
    const ensureFailure = vi.fn(async () => {
      throw new UserFacingError("Prerequisite check failed.");
    });
    const discoverProjects = vi.fn(async () => []);

    await expect(
      runSimplyBuild(
        {
          listDevices: false,
          listProjects: true,
          verbose: false,
          help: false,
        },
        {
          prompts: nonInteractivePrompts(),
          ensureXcodebuildmcpReady: ensureFailure,
          discoverProjects,
        },
      ),
    ).rejects.toMatchObject({
      message: "Prerequisite check failed.",
    });

    expect(ensureFailure).toHaveBeenCalledTimes(1);
    expect(discoverProjects).not.toHaveBeenCalled();
  });
});

describe("runSimplyBuild discovery loading feedback", () => {
  it("records project loading for list-projects mode with count-aware success text", async () => {
    const { prompts, stageCalls } = createRecordingPrompts({ interactive: false });

    await runSimplyBuild(
      {
        listDevices: false,
        listProjects: true,
        verbose: false,
        help: false,
      },
      {
        prompts,
        ensureXcodebuildmcpReady: async () => undefined,
        discoverProjects: async () => [
          { kind: "workspace", path: "/repo/App.xcworkspace", name: "App" },
        ],
      },
    );

    expect(stageCalls).toEqual([
      {
        message: "Loading projects",
        success: "Found 1 project",
        error: "Loading projects",
      },
    ]);
  });

  it("records target loading for list-devices mode with zero-result success text", async () => {
    const { prompts, stageCalls } = createRecordingPrompts({ interactive: false });

    await runSimplyBuild(
      {
        listDevices: true,
        listProjects: false,
        verbose: false,
        help: false,
      },
      {
        prompts,
        ensureXcodebuildmcpReady: async () => undefined,
        discoverTargets: async () => [],
      },
    );

    expect(stageCalls).toEqual([
      {
        message: "Loading devices and simulators",
        success: "No devices or simulators found",
        error: "Loading devices and simulators",
      },
    ]);
  });

  it("records project, scheme, and target loading in the main run path", async () => {
    const { prompts, stageCalls } = createRecordingPrompts({
      interactive: true,
      select: async (message, options) => {
        if (message === "Select scheme") {
          return options[1]?.value as string;
        }
        return options[0]?.value as string;
      },
    });

    await runSimplyBuild(
      {
        query: "screenager",
        listDevices: false,
        listProjects: false,
        verbose: false,
        help: false,
      },
      {
        prompts,
        stateStore: noopStateStore,
        ensureXcodebuildmcpReady: async () => undefined,
        discoverProjects: async () => [
          { kind: "workspace", path: "/repo/App.xcworkspace", name: "App" },
        ],
        discoverSchemes: async () => [
          { name: "App", isLikelyTestScheme: false },
          { name: "App Debug", isLikelyTestScheme: false },
        ],
        discoverTargets: async () => [
          {
            kind: "simulator",
            id: "SIM-1",
            name: "Screenager",
            os: "iOS 26.0",
            state: "Booted",
            isBooted: true,
          },
        ],
        runSimulatorPipeline: async () => undefined,
      },
    );

    expect(stageCalls.map((call) => call.message)).toEqual([
      "Loading projects",
      "Loading schemes",
      "Loading devices and simulators",
    ]);
    expect(stageCalls.map((call) => call.success)).toEqual([
      "Found 1 project",
      "Found 2 schemes",
      "Found 1 device or simulator",
    ]);
  });

  it("records parent-directory loading when the first project scan is empty", async () => {
    const { prompts, stageCalls } = createRecordingPrompts({
      interactive: true,
      confirm: async () => true,
    });
    const discoverProjects = vi.fn(async (scanRoot: string) => {
      if (scanRoot === "/repo/subdir") {
        return [];
      }

      if (scanRoot === "/repo") {
        return [{ kind: "workspace" as const, path: "/repo/App.xcworkspace", name: "App" }];
      }

      throw new Error(`Unexpected scan root: ${scanRoot}`);
    });

    await runSimplyBuild(
      {
        query: "screenager",
        listDevices: false,
        listProjects: false,
        verbose: false,
        help: false,
      },
      {
        cwd: "/repo/subdir",
        prompts,
        stateStore: noopStateStore,
        ensureXcodebuildmcpReady: async () => undefined,
        discoverProjects,
        discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
        discoverTargets: async () => [
          {
            kind: "simulator",
            id: "SIM-1",
            name: "Screenager",
            os: "iOS 26.0",
            state: "Booted",
            isBooted: true,
          },
        ],
        runSimulatorPipeline: async () => undefined,
      },
    );

    expect(stageCalls.slice(0, 2)).toEqual([
      {
        message: "Loading projects",
        success: "No projects found",
        error: "Loading projects",
      },
      {
        message: "Loading parent projects",
        success: "Found 1 project",
        error: "Loading parent projects",
      },
    ]);
    expect(discoverProjects).toHaveBeenNthCalledWith(1, "/repo/subdir");
    expect(discoverProjects).toHaveBeenNthCalledWith(2, "/repo");
  });
});

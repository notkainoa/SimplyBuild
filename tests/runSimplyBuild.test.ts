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

const noopStateStore: StateStore = {
  statePath: "/tmp/state.json",
  getProjectMemory: async () => undefined,
  setProjectContext: async () => undefined,
  markPhysicalDeviceApproved: async () => undefined,
  isPhysicalDeviceApproved: async () => false,
};

describe("runSimplyBuild non-interactive behavior", () => {
  it("fails fast when interactive target selection would be required", async () => {
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
        },
      ),
    ).rejects.toBeInstanceOf(UserFacingError);
  });

  it("fails when query requires disambiguation in non-interactive mode", async () => {
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
  });
});

describe("runSimplyBuild state memory keys", () => {
  it("stores project context using the selected container path key", async () => {
    const getProjectMemory = vi.fn(async () => undefined);
    const setProjectContext = vi.fn(async () => undefined);
    const runSimulator = vi.fn(async () => undefined);

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
  });
});

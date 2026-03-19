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

  it("preselects a remembered physical target when the remembered id matches an alias", async () => {
    let rememberedTarget: string | undefined;
    const prompts: PromptApi = {
      interactive: true,
      intro: () => undefined,
      outro: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      step: () => undefined,
      select: async (message, options, initialValue) => {
        if (message === "Select target device/simulator") {
          rememberedTarget = initialValue as string | undefined;
          return (initialValue as string | undefined) ?? (options[0]?.value as string);
        }
        throw new Error(`Unexpected select prompt: ${message}`);
      },
      confirm: async () => true,
      text: async () => "unused",
      stage: async (_message, task) => task(),
    };

    const runPhysical = vi.fn(async () => undefined);
    const ensureReady = vi.fn(async () => undefined);
    await runSimplyBuild(
      {
        listDevices: false,
        listProjects: false,
        verbose: false,
        help: false,
      },
      {
        prompts,
        ensureXcodebuildmcpReady: ensureReady,
        stateStore: {
          statePath: "/tmp/state.json",
          getProjectMemory: async () => ({
            lastTarget: {
              kind: "physical",
              id: "ecid_legacy",
              name: "Screenager",
            },
            approvedPhysicalDeviceIds: ["UDID-1"],
            updatedAt: "2026-01-02T00:00:00.000Z",
          }),
          setProjectContext: async () => undefined,
          markPhysicalDeviceApproved: async () => undefined,
          isPhysicalDeviceApproved: async () => true,
        },
        discoverProjects: async () => [{ kind: "workspace", path: "/repo/App.xcworkspace", name: "App" }],
        discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
        discoverTargets: async () => [
          {
            kind: "physical",
            id: "UDID-1",
            aliases: ["ecid_legacy"],
            name: "Screenager",
            os: "iOS 26.4",
            state: "Paired (Not Connected)",
            connectionState: "paired_disconnected",
          },
        ],
        runPhysicalPipeline: runPhysical,
      },
    );

    expect(rememberedTarget).toBe("UDID-1");
    expect(runPhysical).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          id: "UDID-1",
        }),
      }),
      prompts,
    );
  });

  it("treats legacy approved physical ids as approved via aliases in non-interactive mode", async () => {
    const isPhysicalDeviceApproved = vi.fn(async (_projectKey: string, deviceId: string) => {
      return deviceId === "ecid_legacy";
    });
    const markPhysicalDeviceApproved = vi.fn(async () => undefined);
    const runPhysical = vi.fn(async () => undefined);
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
        prompts: nonInteractivePrompts(),
        ensureXcodebuildmcpReady: ensureReady,
        stateStore: {
          statePath: "/tmp/state.json",
          getProjectMemory: async () => undefined,
          setProjectContext: async () => undefined,
          markPhysicalDeviceApproved,
          isPhysicalDeviceApproved,
        },
        discoverProjects: async () => [{ kind: "workspace", path: "/repo/App.xcworkspace", name: "App" }],
        discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
        discoverTargets: async () => [
          {
            kind: "physical",
            id: "UDID-1",
            aliases: ["ecid_legacy"],
            name: "Screenager",
            os: "iOS 26.4",
            state: "Paired (Not Connected)",
            connectionState: "paired_disconnected",
          },
        ],
        runPhysicalPipeline: runPhysical,
      },
    );

    expect(isPhysicalDeviceApproved).toHaveBeenCalledWith(
      path.resolve("/repo/App.xcworkspace"),
      "UDID-1",
    );
    expect(isPhysicalDeviceApproved).toHaveBeenCalledWith(
      path.resolve("/repo/App.xcworkspace"),
      "ecid_legacy",
    );
    expect(markPhysicalDeviceApproved).not.toHaveBeenCalled();
    expect(runPhysical).toHaveBeenCalledTimes(1);
  });

  it("stores approval for all known physical target ids after confirmation", async () => {
    const markPhysicalDeviceApproved = vi.fn(async () => undefined);
    const runPhysical = vi.fn(async () => undefined);
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
        prompts: {
          interactive: true,
          intro: () => undefined,
          outro: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          step: () => undefined,
          select: async () => {
            throw new Error("select should not be called");
          },
          confirm: async () => true,
          text: async () => "unused",
          stage: async (_message, task) => task(),
        },
        ensureXcodebuildmcpReady: ensureReady,
        stateStore: {
          statePath: "/tmp/state.json",
          getProjectMemory: async () => undefined,
          setProjectContext: async () => undefined,
          markPhysicalDeviceApproved,
          isPhysicalDeviceApproved: async () => false,
        },
        discoverProjects: async () => [{ kind: "workspace", path: "/repo/App.xcworkspace", name: "App" }],
        discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
        discoverTargets: async () => [
          {
            kind: "physical",
            id: "UDID-1",
            aliases: ["ecid_legacy"],
            name: "Screenager",
            os: "iOS 26.4",
            state: "Paired (Not Connected)",
            connectionState: "paired_disconnected",
          },
        ],
        runPhysicalPipeline: runPhysical,
      },
    );

    const projectKey = path.resolve("/repo/App.xcworkspace");
    expect(markPhysicalDeviceApproved).toHaveBeenCalledWith(projectKey, "UDID-1");
    expect(markPhysicalDeviceApproved).toHaveBeenCalledWith(projectKey, "ecid_legacy");
  });

  it("serializes approval writes for aliased physical device ids", async () => {
    let writeInFlight = false;
    const markPhysicalDeviceApproved = vi.fn(async () => {
      if (writeInFlight) {
        throw new Error("concurrent approval write");
      }
      writeInFlight = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      writeInFlight = false;
    });
    const runPhysical = vi.fn(async () => undefined);
    const ensureReady = vi.fn(async () => undefined);

    await expect(
      runSimplyBuild(
        {
          query: "screenager",
          listDevices: false,
          listProjects: false,
          verbose: false,
          help: false,
        },
        {
          prompts: {
            interactive: true,
            intro: () => undefined,
            outro: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            step: () => undefined,
            select: async () => {
              throw new Error("select should not be called");
            },
            confirm: async () => true,
            text: async () => "unused",
            stage: async (_message, task) => task(),
          },
          ensureXcodebuildmcpReady: ensureReady,
          stateStore: {
            statePath: "/tmp/state.json",
            getProjectMemory: async () => undefined,
            setProjectContext: async () => undefined,
            markPhysicalDeviceApproved,
            isPhysicalDeviceApproved: async () => false,
          },
          discoverProjects: async () => [
            { kind: "workspace", path: "/repo/App.xcworkspace", name: "App" },
          ],
          discoverSchemes: async () => [{ name: "App", isLikelyTestScheme: false }],
          discoverTargets: async () => [
            {
              kind: "physical",
              id: "UDID-1",
              aliases: ["ecid_legacy"],
              name: "Screenager",
              os: "iOS 26.4",
              state: "Paired (Not Connected)",
              connectionState: "paired_disconnected",
            },
          ],
          runPhysicalPipeline: runPhysical,
        },
      ),
    ).resolves.toBeUndefined();

    expect(markPhysicalDeviceApproved).toHaveBeenCalledTimes(2);
    expect(runPhysical).toHaveBeenCalledTimes(1);
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

import { describe, expect, it } from "vitest";
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

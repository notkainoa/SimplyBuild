import { describe, expect, it, vi } from "vitest";
import { createPromptApi } from "../src/ui/prompts.js";

describe("createPromptApi stage", () => {
  it("writes one status line to stderr and runs the task in non-interactive mode", async () => {
    const prompts = createPromptApi(false);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const task = vi.fn(async () => "done");

    try {
      await expect(prompts.stage("Loading projects", task)).resolves.toBe("done");

      expect(task).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith("Loading projects");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

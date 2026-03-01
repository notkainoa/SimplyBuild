import { describe, expect, it } from "vitest";
import { parseCliOptions } from "../src/cliOptions.js";

describe("parseCliOptions", () => {
  it("treats positional input as a target query", () => {
    const result = parseCliOptions(["screenager"]);

    expect(result.parseError).toBeUndefined();
    expect(result.options.query).toBe("screenager");
    expect(result.options.help).toBe(false);
  });

  it("joins unquoted positional input into a single target query", () => {
    const result = parseCliOptions(["screen", "ager"]);

    expect(result.parseError).toBeUndefined();
    expect(result.options.query).toBe("screen ager");
  });

  it("rejects mixing a positional query with --device", () => {
    const result = parseCliOptions(["screenager", "--device", "iPhone 16"]);

    expect(result.parseError).toBe("Use either a positional target query or --device, not both.");
    expect(result.options.help).toBe(true);
  });

  it("rejects mixing a positional query with list commands", () => {
    const result = parseCliOptions(["screenager", "--list-devices"]);

    expect(result.parseError).toBe("Positional target queries cannot be combined with list commands.");
    expect(result.options.help).toBe(true);
  });
});

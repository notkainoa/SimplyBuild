import { describe, expect, it } from "vitest";
import {
  decideTargetFromQuery,
  normalizeMatchString,
  scoreTarget,
} from "../src/matching/targetMatcher.js";
import type { TargetCandidate } from "../src/types.js";

function simulator(id: string, name: string): TargetCandidate {
  return {
    kind: "simulator",
    id,
    name,
    os: "iOS 26.0",
    state: "Shutdown",
    isBooted: false,
  };
}

function physical(id: string, name: string): TargetCandidate {
  return {
    kind: "physical",
    id,
    name,
    os: "iOS 26.2",
    state: "Available",
  };
}

describe("targetMatcher", () => {
  it("normalizes punctuation and spacing", () => {
    expect(normalizeMatchString("  iPhone-15, Pro!!  ")).toBe("iphone 15 pro");
  });

  it("scores exact matches higher", () => {
    const target = simulator("sim-1", "Screenager");
    expect(scoreTarget("screenager", target)).toBe(1);
    expect(scoreTarget("screen", target)).toBeGreaterThan(0.8);
  });

  it("prefers physical target when physical/simulator scores are near equal", () => {
    const decision = decideTargetFromQuery("screenager", [
      simulator("sim-1", "Screenager"),
      physical("dev-1", "Screenager"),
    ]);

    expect(decision.requiresInteractive).toBe(false);
    expect(decision.selected?.kind).toBe("physical");
    expect(decision.reason).toBe("selected-physical-preference");
  });

  it("falls back to interactive when ambiguous", () => {
    const decision = decideTargetFromQuery("iphone", [
      simulator("sim-1", "iPhone 15"),
      simulator("sim-2", "iPhone 16"),
    ]);

    expect(decision.requiresInteractive).toBe(true);
    expect(decision.reason).toBe("ambiguous");
    expect(decision.selected).toBeUndefined();
  });

  it("falls back to interactive when no close match", () => {
    const decision = decideTargetFromQuery("zzzz", [
      simulator("sim-1", "iPhone 17"),
      physical("dev-1", "Screenager"),
    ]);

    expect(decision.requiresInteractive).toBe(true);
    expect(decision.reason).toBe("below-threshold");
  });
});

import { describe, expect, it } from "vitest";
import type { CapabilityCandidate } from "@lobster/shared";
import { SkillRegistry } from "./skillRegistry.js";

function candidate(overrides: Partial<CapabilityCandidate> = {}): CapabilityCandidate {
  return {
    id: overrides.id ?? "candidate-1",
    sourceRuns: overrides.sourceRuns ?? ["run-1"],
    artifactType: overrides.artifactType ?? "declarative-workflow",
    riskClass: overrides.riskClass ?? "green",
    evalScore: overrides.evalScore ?? 0.95,
    promotionState: overrides.promotionState ?? "draft",
    reason: overrides.reason ?? "candidate"
  };
}

describe("SkillRegistry", () => {
  it("keeps explicit promotion state from evolution lab", () => {
    const registry = new SkillRegistry();
    const staged = registry.stageCandidate(candidate({ id: "c1", promotionState: "staging" }));

    expect(staged.promotionState).toBe("staging");
    expect(registry.snapshot().staging.map((item) => item.id)).toContain("c1");
  });

  it("moves staging candidates to stable when observation review passes", () => {
    const registry = new SkillRegistry();
    registry.stageCandidate(candidate({ id: "c2", promotionState: "staging" }));

    const reviewed = registry.reviewStaging("c2", true, "window passed");

    expect(reviewed?.promotionState).toBe("stable");
    expect(registry.snapshot().stable.map((item) => item.id)).toContain("c2");
  });

  it("moves staging candidates to held when observation review fails", () => {
    const registry = new SkillRegistry();
    registry.stageCandidate(candidate({ id: "c3", promotionState: "staging" }));

    const reviewed = registry.reviewStaging("c3", false, "unexpected flake");

    expect(reviewed?.promotionState).toBe("held");
    expect(reviewed?.reason).toContain("Observation window review failed");
    expect(registry.snapshot().held.map((item) => item.id)).toContain("c3");
  });
});

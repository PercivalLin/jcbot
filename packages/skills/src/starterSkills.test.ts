import { describe, expect, it } from "vitest";
import { isAutoPromotableCandidate } from "./starterSkills.js";

describe("isAutoPromotableCandidate", () => {
  it("only allows low-risk declarative workflows", () => {
    expect(
      isAutoPromotableCandidate({
        id: "a",
        sourceRuns: ["run-1"],
        artifactType: "declarative-workflow",
        riskClass: "green",
        evalScore: 0.95,
        promotionState: "draft",
        reason: "safe"
      })
    ).toBe(true);

    expect(
      isAutoPromotableCandidate({
        id: "b",
        sourceRuns: ["run-2"],
        artifactType: "plugin",
        riskClass: "green",
        evalScore: 0.99,
        promotionState: "draft",
        reason: "unsafe"
      })
    ).toBe(false);
  });
});

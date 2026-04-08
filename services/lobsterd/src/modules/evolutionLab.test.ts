import { describe, expect, it } from "vitest";
import { EvolutionLab } from "./evolutionLab.js";

describe("EvolutionLab", () => {
  it("auto-stages low-risk declarative candidates when evaluation evidence passes", () => {
    const lab = new EvolutionLab();
    const candidate = lab.deriveCandidate({
      sourceRunId: "run-2",
      actions: [
        {
          id: "a1",
          kind: "ui.inspect",
          riskLevel: "green",
          args: {},
          preconditions: [],
          successCheck: []
        }
      ],
      evalScore: 0.95,
      summary: "Safe workflow",
      sandboxReplayPassed: true,
      traceRecheckPassed: true,
      noPermissionEscalation: true
    });

    expect(candidate.riskClass).toBe("green");
    expect(candidate.promotionState).toBe("staging");
  });

  it("holds candidates when replay evidence is missing", () => {
    const lab = new EvolutionLab();
    const candidate = lab.deriveCandidate({
      sourceRunId: "run-3",
      actions: [
        {
          id: "a1",
          kind: "ui.read",
          riskLevel: "green",
          args: {},
          preconditions: [],
          successCheck: []
        }
      ],
      evalScore: 0.96,
      summary: "Evidence incomplete"
    });

    expect(candidate.promotionState).toBe("held");
    expect(candidate.reason).toContain("Sandbox replay has not passed yet");
  });

  it("rejects candidates that contain redline actions", () => {
    const lab = new EvolutionLab();
    const candidate = lab.deriveCandidate({
      sourceRunId: "run-1",
      actions: [
        {
          id: "a1",
          kind: "external.send_message",
          riskLevel: "red",
          args: {},
          preconditions: [],
          successCheck: []
        }
      ],
      evalScore: 0.99,
      summary: "Unsafe workflow"
    });

    expect(candidate.riskClass).toBe("red");
    expect(candidate.promotionState).toBe("rejected");
  });
});

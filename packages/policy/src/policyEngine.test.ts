import { describe, expect, it } from "vitest";
import { createApprovalToken } from "./approval.js";
import { gateAction } from "./policyEngine.js";
import type { DesktopAction, SelfCheckResult } from "@lobster/shared";

const yellowAction: DesktopAction = {
  id: "1",
  kind: "external.select_contact",
  riskLevel: "yellow",
  args: { contact: "Alice" },
  preconditions: [],
  successCheck: []
};

const redAction: DesktopAction = {
  id: "2",
  kind: "external.send_message",
  riskLevel: "red",
  args: { message: "hello" },
  preconditions: [],
  successCheck: []
};

describe("gateAction", () => {
  it("blocks hard redlines", () => {
    const decision = gateAction({
      action: redAction,
      selfCheck: {
        overallRisk: "red",
        blocked: true,
        explanation: "nope",
        findings: [
          {
            ruleId: "redline.outbound-message",
            riskLevel: "red",
            whyFlagged: "Never send messages automatically",
            proposedSafeAlternative: "Ask first",
            needsHumanApproval: false
          }
        ]
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("red");
  });

  it("allows yellow with a matching token", () => {
    const selfCheck: SelfCheckResult = {
      overallRisk: "yellow",
      blocked: false,
      explanation: "verify contact",
      findings: [
        {
          ruleId: "caution.contact-switch",
          riskLevel: "yellow",
          whyFlagged: "verify contact",
          proposedSafeAlternative: "ask",
          needsHumanApproval: true
        }
      ]
    };

    const token = createApprovalToken({
      runId: "run-1",
      action: yellowAction,
      approvedBy: "user-1",
      riskLevel: "yellow",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const decision = gateAction({ action: yellowAction, selfCheck, approvalToken: token });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });
});

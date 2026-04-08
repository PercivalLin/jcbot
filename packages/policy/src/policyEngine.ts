import type { ApprovalToken, DesktopAction, PolicyDecision, SelfCheckResult } from "@lobster/shared";
import { HARD_REDLINE_RULE_IDS } from "./constitution.js";
import { isApprovalTokenValid } from "./approval.js";

export function gateAction(params: {
  action: DesktopAction;
  selfCheck: SelfCheckResult;
  approvalToken?: ApprovalToken;
}): PolicyDecision {
  const ruleIds = params.selfCheck.findings.map((finding) => finding.ruleId);
  const hasHardRedline = ruleIds.some((ruleId) => HARD_REDLINE_RULE_IDS.has(ruleId));

  if (hasHardRedline) {
    return {
      allowed: false,
      riskLevel: "red",
      requiresApproval: false,
      reason: "This action triggers a hard redline and cannot be executed.",
      ruleIds
    };
  }

  if (params.selfCheck.overallRisk === "yellow") {
    if (params.approvalToken && isApprovalTokenValid(params.approvalToken, params.action)) {
      return {
        allowed: true,
        riskLevel: "yellow",
        requiresApproval: false,
        reason: "Yellow action allowed by a single-use approval token.",
        ruleIds
      };
    }

    return {
      allowed: false,
      riskLevel: "yellow",
      requiresApproval: true,
      reason: "This action requires a yellow-line approval token.",
      ruleIds
    };
  }

  return {
    allowed: true,
    riskLevel: "green",
    requiresApproval: false,
    reason: "Action allowed by the policy engine.",
    ruleIds
  };
}

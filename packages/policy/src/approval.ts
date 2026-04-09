import { randomUUID } from "node:crypto";
import type { ApprovalToken, DesktopAction, RiskLevel } from "@lobster/shared";
import { fingerprintCanonicalAction } from "./canonicalAction.js";

export function createApprovalToken(input: {
  runId: string;
  action: DesktopAction;
  approvedBy: string;
  riskLevel: RiskLevel;
  expiresAt: string;
}): ApprovalToken {
  return {
    id: randomUUID(),
    runId: input.runId,
    actionFingerprint: hashApprovalAction(input.action),
    riskLevel: input.riskLevel,
    approvedBy: input.approvedBy,
    expiresAt: input.expiresAt,
    singleUse: true
  };
}

export function hashApprovalAction(action: DesktopAction): string {
  return fingerprintCanonicalAction(action);
}

export function isApprovalTokenValid(token: ApprovalToken, action: DesktopAction, now = new Date()): boolean {
  return token.actionFingerprint === hashApprovalAction(action) && new Date(token.expiresAt) > now;
}

import { createHash, randomUUID } from "node:crypto";
import type { ApprovalToken, DesktopAction, RiskLevel } from "@lobster/shared";

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
  return createHash("sha256")
    .update(JSON.stringify({ kind: action.kind, target: action.target, args: action.args }))
    .digest("hex");
}

export function isApprovalTokenValid(token: ApprovalToken, action: DesktopAction, now = new Date()): boolean {
  return token.actionFingerprint === hashApprovalAction(action) && new Date(token.expiresAt) > now;
}


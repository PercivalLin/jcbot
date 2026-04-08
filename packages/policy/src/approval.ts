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
    .update(serializeApprovalValue({ kind: action.kind, target: action.target, args: action.args ?? {} }))
    .digest("hex");
}

export function isApprovalTokenValid(token: ApprovalToken, action: DesktopAction, now = new Date()): boolean {
  return token.actionFingerprint === hashApprovalAction(action) && new Date(token.expiresAt) > now;
}

function serializeApprovalValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeApprovalValue(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${serializeApprovalValue(entryValue)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

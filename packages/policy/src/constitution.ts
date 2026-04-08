import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type { DesktopAction, RiskLevel, SelfCheckFinding, SelfCheckResult } from "@lobster/shared";

export type ConstitutionRule = {
  id: string;
  level: RiskLevel;
  actionKinds: string[];
  summary: string;
  alternative: string;
};

export type ConstitutionPack = {
  version: number;
  packs: Record<string, { title: string; rules: ConstitutionRule[] }>;
};

export const HARD_REDLINE_RULE_IDS = new Set([
  "redline.outbound-message",
  "redline.delete-record",
  "redline.payment",
  "redline.security-policy"
]);

export function loadConstitution(path: string): ConstitutionPack {
  const raw = readFileSync(path, "utf8");
  return YAML.parse(raw) as ConstitutionPack;
}

export function flattenRules(pack: ConstitutionPack): ConstitutionRule[] {
  return Object.values(pack.packs).flatMap((entry) => entry.rules);
}

export function fingerprintAction(action: DesktopAction): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: action.kind, target: action.target, args: action.args }))
    .digest("hex");
}

export function evaluateActionAgainstConstitution(
  action: DesktopAction,
  rules: ConstitutionRule[]
): SelfCheckResult {
  const findings = rules
    .filter((rule) => rule.actionKinds.includes(action.kind))
    .map<SelfCheckFinding>((rule) => ({
      ruleId: rule.id,
      riskLevel: rule.level,
      whyFlagged: rule.summary,
      proposedSafeAlternative: rule.alternative,
      needsHumanApproval: rule.level === "yellow"
    }));

  const overallRisk = findings.some((finding) => finding.riskLevel === "red")
    ? "red"
    : findings.some((finding) => finding.riskLevel === "yellow")
      ? "yellow"
      : "green";

  const explanation =
    findings.length === 0
      ? "No constitution rule was triggered."
      : findings
          .map(
            (finding) =>
              `${finding.ruleId}: ${finding.whyFlagged} Suggested alternative: ${finding.proposedSafeAlternative}`
          )
          .join(" ");

  return {
    overallRisk,
    findings,
    blocked: overallRisk === "red",
    explanation
  };
}

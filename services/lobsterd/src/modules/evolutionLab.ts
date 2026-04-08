import { randomUUID } from "node:crypto";
import type { CapabilityCandidate, DesktopAction } from "@lobster/shared";

const HARD_REDLINE_ACTION_KINDS = new Set([
  "external.send_message",
  "file.delete",
  "record.delete",
  "commerce.pay",
  "commerce.checkout",
  "security.privilege_escalation",
  "policy.modify",
  "runtime.modify",
  "bridge.modify"
]);

const AUTO_PROMOTION_FORBIDDEN_ACTION_KINDS = new Set([
  ...HARD_REDLINE_ACTION_KINDS,
  "external.upload_file",
  "shell.execute_script",
  "terminal.execute_script",
  "system.install_software",
  "security.modify_settings",
  "models.modify_config"
]);

function actionSetContainsRedline(actions: DesktopAction[]) {
  return actions.some((action) => HARD_REDLINE_ACTION_KINDS.has(action.kind));
}

function deriveRiskClass(actions: DesktopAction[]): CapabilityCandidate["riskClass"] {
  if (actions.some((action) => HARD_REDLINE_ACTION_KINDS.has(action.kind))) {
    return "red";
  }

  if (actions.some((action) => action.riskLevel === "yellow")) {
    return "yellow";
  }

  return "green";
}

function evaluateAutoPromotionEligibility(actions: DesktopAction[]) {
  const reasons: string[] = [];
  if (actions.length === 0) {
    reasons.push("No actions were provided for this candidate.");
  }

  const nonGreenActions = actions.filter((action) => action.riskLevel !== "green");
  if (nonGreenActions.length > 0) {
    const kinds = [...new Set(nonGreenActions.map((action) => action.kind))].join(", ");
    reasons.push(`Candidate contains non-green actions: ${kinds}.`);
  }

  const forbiddenActions = actions.filter((action) => AUTO_PROMOTION_FORBIDDEN_ACTION_KINDS.has(action.kind));
  if (forbiddenActions.length > 0) {
    const kinds = [...new Set(forbiddenActions.map((action) => action.kind))].join(", ");
    reasons.push(`Candidate contains forbidden auto-promotion actions: ${kinds}.`);
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

export class EvolutionLab {
  deriveCandidate(params: {
    sourceRunId: string;
    actions: DesktopAction[];
    evalScore: number;
    summary: string;
    artifactType?: CapabilityCandidate["artifactType"];
    sandboxReplayPassed?: boolean;
    traceRecheckPassed?: boolean;
    noPermissionEscalation?: boolean;
  }): CapabilityCandidate {
    const hasRedline = actionSetContainsRedline(params.actions);
    const riskClass = deriveRiskClass(params.actions);
    const artifactType = params.artifactType ?? "declarative-workflow";
    const gateCheck = evaluateAutoPromotionEligibility(params.actions);
    const sandboxReplayPassed = params.sandboxReplayPassed ?? false;
    const traceRecheckPassed = params.traceRecheckPassed ?? false;
    const noPermissionEscalation = params.noPermissionEscalation ?? false;
    const evidenceFailures = [
      sandboxReplayPassed ? undefined : "Sandbox replay has not passed yet.",
      traceRecheckPassed ? undefined : "Trace recheck has not passed yet.",
      noPermissionEscalation ? undefined : "Permission escalation check has not passed yet."
    ].filter((item): item is string => Boolean(item));

    if (hasRedline) {
      return {
        id: randomUUID(),
        sourceRuns: [params.sourceRunId],
        artifactType,
        riskClass,
        evalScore: params.evalScore,
        promotionState: "rejected",
        reason: "Candidate contains a hard redline action and is rejected."
      };
    }

    const meetsAutoPromotionBase =
      artifactType === "declarative-workflow" &&
      riskClass === "green" &&
      params.evalScore >= 0.9 &&
      gateCheck.eligible;
    const canAutoStage = meetsAutoPromotionBase && evidenceFailures.length === 0;
    const blockedReasons = [
      ...gateCheck.reasons,
      ...evidenceFailures,
      artifactType === "declarative-workflow" ? undefined : "Only declarative-workflow candidates can auto-promote.",
      riskClass === "green" ? undefined : "Only green risk candidates can auto-promote.",
      params.evalScore >= 0.9 ? undefined : "Eval score is below auto-promotion threshold (0.90)."
    ].filter((item): item is string => Boolean(item));

    return {
      id: randomUUID(),
      sourceRuns: [params.sourceRunId],
      artifactType,
      riskClass,
      evalScore: params.evalScore,
      promotionState: canAutoStage ? "staging" : "held",
      reason:
        blockedReasons.length > 0
          ? `${params.summary} ${blockedReasons.join(" ")}`
          : params.summary
    };
  }
}

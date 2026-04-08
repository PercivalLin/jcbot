import type { DesktopObservation, DesktopAction, VerificationResult } from "@lobster/shared";

export function buildPlannerPrompt(requestText: string, observation?: DesktopObservation) {
  return [
    `Create a compact plan for this task: ${requestText}`,
    observation
      ? [
          `Current desktop context: active app ${observation.activeApp}; windows ${observation.windows.join(", ")}; candidates ${observation.candidates.map((candidate) => candidate.label).join(", ")}.`,
          observation.ocrText.length > 0
            ? `OCR text: ${observation.ocrText.slice(0, 24).join(", ")}.`
            : "OCR text: none."
        ].join(" ")
      : "Current desktop context is not yet available."
  ].join("\n");
}

export function buildVisionVerificationSystemPrompt() {
  return [
    "You verify whether a macOS desktop action succeeded.",
    "Return strict JSON only.",
    'Schema: {"status":"verified"|"dispatched_unverified"|"failed","message":"...","confidence":0..1}.',
    "Use verified only when the screenshot strongly supports success.",
    "Use failed only when the screenshot strongly contradicts success.",
    "Otherwise use dispatched_unverified."
  ].join("\n");
}

export function buildVisionVerificationPrompt(input: {
  action: DesktopAction;
  before: DesktopObservation | undefined;
  after: DesktopObservation;
  base: VerificationResult;
  focusedElementSummary: string;
  candidateSummaries: string[];
  recentEventKinds: string[];
  textSummary?: string;
}) {
  const target = input.action.target ? `Target: ${input.action.target}` : "Target: none";
  const text = input.textSummary ? `Text: ${input.textSummary}` : "Text: none";

  return [
    `Action kind: ${input.action.kind}`,
    target,
    text,
    `Before active app: ${input.before?.activeApp ?? "unknown"}`,
    `Before window: ${input.before?.activeWindowTitle ?? "unknown"}`,
    `After active app: ${input.after.activeApp}`,
    `After window: ${input.after.activeWindowTitle ?? "unknown"}`,
    `Focused element: ${input.focusedElementSummary || "none"}`,
    `Visible candidates: ${input.candidateSummaries.join("; ") || "none"}`,
    `Recent accessibility events: ${input.recentEventKinds.join(", ") || "none"}`,
    `OCR text: ${input.after.ocrText.slice(0, 20).join("; ") || "none"}`,
    `Current local verification: ${input.base.status}`,
    `Current local explanation: ${input.base.message}`,
    "Decide whether the screenshot supports success, failure, or remains inconclusive."
  ].join("\n");
}

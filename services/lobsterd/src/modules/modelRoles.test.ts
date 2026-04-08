import { describe, expect, it } from "vitest";
import type { DesktopAction, DesktopObservation, VerificationResult } from "@lobster/shared";
import {
  buildPlannerPrompt,
  buildVisionVerificationPrompt,
  buildVisionVerificationSystemPrompt
} from "./modelRoles.js";

describe("modelRoles prompts", () => {
  it("includes OCR context in the planner prompt", () => {
    const observation: DesktopObservation = {
      screenshotRef: "stub://snapshot",
      activeApp: "WeChat",
      activeWindowTitle: "Alice Chat",
      ocrText: ["Alice", "Search", "hello world"],
      windows: ["WeChat: Alice Chat"],
      candidates: [
        {
          id: "search",
          role: "text field",
          label: "Search",
          value: "",
          confidence: 0.92,
          source: "ax"
        }
      ]
    };

    const prompt = buildPlannerPrompt('在 "Search" 输入 "hello world"', observation);

    expect(prompt).toContain("active app WeChat");
    expect(prompt).toContain("OCR text: Alice, Search, hello world.");
  });

  it("builds a strict vision verification prompt with OCR and local verification context", () => {
    const action: DesktopAction = {
      id: "step-1",
      kind: "ui.type_into_target",
      target: "Search",
      args: {
        text: "hello world"
      },
      riskLevel: "green",
      preconditions: [],
      successCheck: []
    };
    const after: DesktopObservation = {
      screenshotRef: "stub://snapshot",
      activeApp: "WeChat",
      activeWindowTitle: "Search",
      ocrText: ["Search", "hello world"],
      windows: ["WeChat: Search"],
      candidates: [
        {
          id: "ocr-search",
          role: "text",
          label: "Search",
          value: "hello world",
          confidence: 0.84,
          source: "ocr"
        }
      ]
    };
    const base: VerificationResult = {
      status: "dispatched_unverified",
      message: "Hotkey dispatched, but post-action state was not directly verifiable.",
      evidence: [],
      evidenceItems: []
    };

    const systemPrompt = buildVisionVerificationSystemPrompt();
    const prompt = buildVisionVerificationPrompt({
      action,
      before: undefined,
      after,
      base,
      focusedElementSummary: "",
      candidateSummaries: ["ocr-search|text|search|hello world|0"],
      recentEventKinds: ["value.changed"],
      textSummary: "hello world"
    });

    expect(systemPrompt).toContain("Return strict JSON only.");
    expect(prompt).toContain("Action kind: ui.type_into_target");
    expect(prompt).toContain("OCR text: Search; hello world");
    expect(prompt).toContain("Current local verification: dispatched_unverified");
  });
});

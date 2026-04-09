import { describe, expect, it } from "vitest";
import type { DesktopAction } from "@lobster/shared";
import { createApprovalToken, hashApprovalAction, isApprovalTokenValid } from "./approval.js";

const parityFixtureAction: DesktopAction = {
  id: "action-click-target",
  kind: "ui.click_target",
  target: "Lobster OCR",
  args: {},
  targetDescriptor: {
    candidateId: "ocr-1",
    label: "Lobster OCR",
    role: "text",
    source: "ocr",
    bounds: {
      x: 12,
      y: 24,
      width: 160,
      height: 32
    },
    observationId: "bridge://observation/test",
    screenshotRef: "bridge://snapshot/test",
    snapshotAt: "2026-04-08T12:00:00Z"
  },
  riskLevel: "yellow",
  preconditions: [],
  successCheck: []
};

describe("approval token hashing", () => {
  it("matches the canonical cross-layer fingerprint fixture", () => {
    expect(hashApprovalAction(parityFixtureAction)).toBe(
      "fa6f55bee39c28e4ec179f4dc30eb3203b6a0b6ecdedb852fb61ba4b272660dd"
    );
  });

  it("normalizes nested args before hashing", () => {
    const left: DesktopAction = {
      id: "shared-action",
      kind: "external.upload_file",
      target: "/tmp/report.pdf",
      args: {
        options: {
          retries: 2,
          mode: "safe"
        },
        tags: ["one", "two"]
      },
      riskLevel: "yellow",
      preconditions: [],
      successCheck: []
    };
    const right: DesktopAction = {
      ...left,
      args: {
        tags: ["one", "two"],
        options: {
          mode: "safe",
          retries: 2
        }
      }
    };

    expect(hashApprovalAction(left)).toBe(hashApprovalAction(right));
  });

  it("treats actionId as part of the approval fingerprint", () => {
    const approvedAction: DesktopAction = {
      id: "action-a",
      kind: "external.upload_file",
      target: "/tmp/report.pdf",
      args: {
        filePath: "/tmp/report.pdf"
      },
      riskLevel: "yellow",
      preconditions: [],
      successCheck: []
    };
    const mutatedAction: DesktopAction = {
      ...approvedAction,
      id: "action-b"
    };

    expect(hashApprovalAction(approvedAction)).not.toBe(hashApprovalAction(mutatedAction));
  });

  it("rejects approval tokens when the action fingerprint no longer matches", () => {
    const approvedAction: DesktopAction = {
      id: "approved",
      kind: "external.select_contact",
      target: "Alice",
      args: {
        contact: "Alice"
      },
      riskLevel: "yellow",
      preconditions: [],
      successCheck: []
    };
    const mutatedAction: DesktopAction = {
      ...approvedAction,
      target: "Bob",
      args: {
        contact: "Bob"
      }
    };

    const token = createApprovalToken({
      runId: "run-1",
      action: approvedAction,
      approvedBy: "tester",
      riskLevel: "yellow",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(isApprovalTokenValid(token, approvedAction)).toBe(true);
    expect(isApprovalTokenValid(token, mutatedAction)).toBe(false);
  });

  it("treats target provenance as part of the approval fingerprint", () => {
    const approvedAction: DesktopAction = {
      id: "approved",
      kind: "ui.click_target",
      target: "Search",
      args: {},
      targetDescriptor: {
        candidateId: "ocr-search",
        label: "Search",
        source: "ocr",
        observationId: "bridge://observation/current",
        bounds: {
          x: 120,
          y: 80,
          width: 140,
          height: 32
        },
        screenshotRef: "bridge://snapshot/current",
        snapshotAt: "2026-04-08T12:00:00.000Z"
      },
      riskLevel: "yellow",
      preconditions: [],
      successCheck: []
    };
    const mutatedAction: DesktopAction = {
      ...approvedAction,
      targetDescriptor: {
        ...approvedAction.targetDescriptor!,
        screenshotRef: "bridge://snapshot/other"
      }
    };

    const token = createApprovalToken({
      runId: "run-2",
      action: approvedAction,
      approvedBy: "tester",
      riskLevel: "yellow",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(isApprovalTokenValid(token, approvedAction)).toBe(true);
    expect(isApprovalTokenValid(token, mutatedAction)).toBe(false);
  });

  it.each([
    [
      "observationId",
      {
        ...parityFixtureAction,
        targetDescriptor: {
          ...parityFixtureAction.targetDescriptor!,
          observationId: "bridge://observation/other"
        }
      } satisfies DesktopAction
    ],
    [
      "screenshotRef",
      {
        ...parityFixtureAction,
        targetDescriptor: {
          ...parityFixtureAction.targetDescriptor!,
          screenshotRef: "bridge://snapshot/other"
        }
      } satisfies DesktopAction
    ],
    [
      "snapshotAt",
      {
        ...parityFixtureAction,
        targetDescriptor: {
          ...parityFixtureAction.targetDescriptor!,
          snapshotAt: "2026-04-08T12:00:01Z"
        }
      } satisfies DesktopAction
    ],
    [
      "bounds",
      {
        ...parityFixtureAction,
        targetDescriptor: {
          ...parityFixtureAction.targetDescriptor!,
          bounds: {
            ...parityFixtureAction.targetDescriptor!.bounds!,
            width: 161
          }
        }
      } satisfies DesktopAction
    ]
  ])("changes the fingerprint when %s changes", (_field, mutatedAction) => {
    expect(hashApprovalAction(mutatedAction)).not.toBe(hashApprovalAction(parityFixtureAction));
  });

  it("ignores duplicated targetDescriptor payload nested inside args", () => {
    const nestedDescriptorAction: DesktopAction = {
      ...parityFixtureAction,
      args: {
        targetDescriptor: {
          candidateId: "nested-only",
          label: "Wrong Descriptor",
          source: "vision"
        }
      }
    };

    expect(hashApprovalAction(nestedDescriptorAction)).toBe(hashApprovalAction(parityFixtureAction));
  });
});

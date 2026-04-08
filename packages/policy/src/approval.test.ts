import { describe, expect, it } from "vitest";
import type { DesktopAction } from "@lobster/shared";
import { createApprovalToken, hashApprovalAction, isApprovalTokenValid } from "./approval.js";

describe("approval token hashing", () => {
  it("normalizes nested args before hashing", () => {
    const left: DesktopAction = {
      id: "left",
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
      id: "right",
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
        snapshotRef: "bridge://snapshot/other"
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
});

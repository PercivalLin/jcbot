import type { ApprovalTicket, CapabilityCandidate, InboxItem, ModelProfile, TaskRequest, TaskRun } from "@lobster/shared";

type RuntimeReadinessReport = {
  checks: Array<{
    id: string;
    level: "ok" | "warn" | "fail";
    message: string;
    suggestion?: string;
  }>;
  generatedAt: string;
  summary: {
    fail: number;
    ok: number;
    warn: number;
  };
};

export const lobsterApi = {
  listRuns: () => window.lobster.rpc("run.list") as Promise<TaskRun[]>,
  createTask: (request: TaskRequest) => window.lobster.rpc("task.create", request),
  listApprovals: () => window.lobster.rpc("approval.list") as Promise<ApprovalTicket[]>,
  bridgeCapabilities: () =>
    window.lobster.rpc("bridge.capabilities") as Promise<{
      accessibility: boolean;
      eventTap: boolean;
      ocr: boolean;
      policyHardGate: boolean;
      screenCapture: boolean;
    }>,
  listModels: () =>
    window.lobster.rpc("models.list") as Promise<Record<ModelProfile["role"], ModelProfile>>,
  runtimeReadiness: () => window.lobster.rpc("runtime.readiness") as Promise<RuntimeReadinessReport | undefined>,
  listSkills: () =>
    window.lobster.rpc("skills.list") as Promise<{
      starter: unknown[];
      staging: CapabilityCandidate[];
      stable: CapabilityCandidate[];
      held: CapabilityCandidate[];
    }>,
  listInbox: () => window.lobster.rpc("inbox.list") as Promise<InboxItem[]>,
  approveTicket: (ticketId: string, approvedBy: string) =>
    window.lobster.rpc("approval.approve", { ticketId, approvedBy }),
  denyTicket: (ticketId: string) => window.lobster.rpc("approval.deny", { ticketId })
};

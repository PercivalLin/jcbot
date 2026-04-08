import type { ApprovalTicket, TaskRequest, TaskRun } from "@lobster/shared";

type RuntimeNotifierTaskBundle = {
  approvalTicket?: ApprovalTicket;
  run: TaskRun;
};

export interface RuntimeNotifier {
  notifyApprovalRequested(request: TaskRequest, bundle: RuntimeNotifierTaskBundle): Promise<void>;
  notifyApprovalResolved(request: TaskRequest, bundle: RuntimeNotifierTaskBundle, decision: "approved" | "denied"): Promise<void>;
  notifyRunSettled(request: TaskRequest, run: TaskRun): Promise<void>;
}

export class NoopRuntimeNotifier implements RuntimeNotifier {
  async notifyApprovalRequested() {}
  async notifyApprovalResolved() {}
  async notifyRunSettled() {}
}

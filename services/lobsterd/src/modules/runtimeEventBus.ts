import type { ApprovalTicket, RunEvent, TaskRun } from "@lobster/shared";

export type RuntimeStreamEvent = {
  approvalTicket?: ApprovalTicket;
  event: RunEvent;
  run: TaskRun;
  type: "run.event";
};

type RuntimeEventListener = (event: RuntimeStreamEvent) => void | Promise<void>;

export class RuntimeEventBus {
  private readonly listeners = new Set<RuntimeEventListener>();

  subscribe(listener: RuntimeEventListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeStreamEvent) {
    for (const listener of this.listeners) {
      void Promise.resolve(listener(event)).catch((error) => {
        console.warn(
          `Runtime event listener error: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }
}

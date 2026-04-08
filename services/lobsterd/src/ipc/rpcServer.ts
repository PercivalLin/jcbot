import { randomUUID } from "node:crypto";
import net from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalTicket,
  CapabilityCandidate,
  JsonRpcRequest,
  JsonRpcResponse,
  RunEvent,
  TaskRequest,
  TaskRun
} from "@lobster/shared";
import { jsonRpcRequestSchema } from "@lobster/shared";
import { createApprovalToken } from "@lobster/policy";
import type { RuntimePersistence } from "@lobster/storage";
import { InboxEngine } from "../modules/inboxEngine.js";
import type { NotificationSignal } from "../modules/inboxEngine.js";
import type { BridgeClient } from "../modules/bridgeClient.js";
import { ModelRouter } from "../modules/modelRouter.js";
import { SkillRegistry } from "../modules/skillRegistry.js";
import { TaskOrchestrator } from "../modules/taskOrchestrator.js";
import { EvolutionLab } from "../modules/evolutionLab.js";
import type { RuntimeNotifier } from "../modules/runtimeNotifier.js";
import type { ChatPluginInstance } from "../modules/chatPluginRegistry.js";
import type { RuntimeReadinessReport } from "../modules/runtimeReadiness.js";
import type { RuntimeEventBus } from "../modules/runtimeEventBus.js";

type RuntimeState = {
  approvals: Map<string, ApprovalTicket>;
  runs: Map<string, TaskRun>;
  runsByRequestKey: Map<string, string>;
};

type RpcServerOptions = {
  chatPlugins?: ChatPluginInstance[];
  eventBus?: RuntimeEventBus;
  notificationWhitelist?: string[];
  runtimeReadinessProvider?: () => Promise<RuntimeReadinessReport> | RuntimeReadinessReport;
};

const IN_FLIGHT_RUN_STATUSES = new Set<TaskRun["status"]>([
  "queued",
  "context_build",
  "planned",
  "self_checked",
  "awaiting_approval",
  "executing",
  "verifying"
]);

export function consumeNewlineDelimitedChunk(buffer: string, chunk: Buffer | string) {
  const nextBuffer = buffer + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  const segments = nextBuffer.split("\n");
  return {
    buffer: segments.pop() ?? "",
    lines: segments.map((line) => line.trim()).filter(Boolean)
  };
}

export class RpcServer {
  private readonly orchestrator: TaskOrchestrator;
  private readonly skillRegistry = new SkillRegistry();
  private readonly inboxEngine: InboxEngine;
  private readonly evolutionLab = new EvolutionLab();
  private readonly chatPlugins: ChatPluginInstance[];
  private readonly eventBus?: RuntimeEventBus;
  private readonly runtimeReadinessProvider?: () => Promise<RuntimeReadinessReport> | RuntimeReadinessReport;
  private readonly state: RuntimeState = {
    approvals: new Map(),
    runs: new Map(),
    runsByRequestKey: new Map()
  };
  private desktopQueue = Promise.resolve();

  constructor(
    private readonly socketPath: string,
    private readonly modelRouter: ModelRouter,
    private readonly persistence: RuntimePersistence,
    private readonly bridgeClient: BridgeClient,
    private readonly notifier: RuntimeNotifier,
    options: RpcServerOptions = {}
  ) {
    this.chatPlugins = [...(options.chatPlugins ?? [])];
    this.eventBus = options.eventBus;
    this.runtimeReadinessProvider = options.runtimeReadinessProvider;
    this.orchestrator = new TaskOrchestrator(modelRouter, bridgeClient, {
      chatPlugins: this.chatPlugins,
      onRunEvent: async (event, run) => {
        await this.recordRunEvent(event, run);
      }
    });
    this.inboxEngine = new InboxEngine({
      notificationWhitelist: options.notificationWhitelist
    });
  }

  async start() {
    await this.loadState();

    mkdirSync(dirname(this.socketPath), { recursive: true });
    rmSync(this.socketPath, { force: true });

    const server = net.createServer((socket) => {
      let buffer = "";
      let processing = Promise.resolve();
      socket.on("data", (chunk) => {
        const next = consumeNewlineDelimitedChunk(buffer, chunk);
        buffer = next.buffer;
        const { lines } = next;

        processing = processing
          .then(async () => {
            for (const line of lines) {
              const response = await this.handleLine(line);
              socket.write(`${JSON.stringify(response)}\n`);
            }
          })
          .catch((error) => {
            console.warn(`RPC socket processing error: ${error instanceof Error ? error.message : String(error)}`);
          });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => resolve());
    });

    return server;
  }

  async createTask(request: TaskRequest) {
    return this.runDesktopWork(async () => {
      const existingRunId = this.state.runsByRequestKey.get(this.requestKey(request));
      if (existingRunId) {
        const existingRun = this.state.runs.get(existingRunId) ?? (await this.persistence.getRun(existingRunId));
        if (existingRun) {
          return {
            run: existingRun,
            approvalTicket: this.findPendingApprovalForRun(existingRun.runId)
          };
        }
        this.state.runsByRequestKey.delete(this.requestKey(request));
      }

      const created = await this.orchestrator.createRun(request);
      await this.persistRunBundle(created.run, created.approvalTicket);
      await this.notifyTaskCreated(request, created.run, created.approvalTicket);
      return created;
    });
  }

  async approveTicket(ticketId: string, approvedBy: string) {
    return this.runDesktopWork(async () => {
      const ticket = this.state.approvals.get(ticketId) ?? (await this.persistence.getApproval(ticketId));
      if (!ticket) {
        throw new Error(`Approval ticket ${ticketId} not found.`);
      }

      const run = this.state.runs.get(ticket.runId) ?? (await this.persistence.getRun(ticket.runId));
      if (!run) {
        throw new Error(`Task run ${ticket.runId} not found.`);
      }

      this.assertPendingTicket(ticket);
      this.assertRunAwaitingApproval(run, ticket.id);

      const token = createApprovalToken({
        runId: ticket.runId,
        action: ticket.action,
        approvedBy,
        riskLevel: "yellow",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      });

      const resumed = await this.orchestrator.resumeRun(run, token);
      const approvedTicket: ApprovalTicket = {
        ...ticket,
        state: "approved"
      };
      await this.persistence.saveApproval(approvedTicket);
      this.state.approvals.set(approvedTicket.id, approvedTicket);
      await this.recordRunEvent(
        {
          eventId: randomUUID(),
          runId: run.runId,
          kind: "approval.resolved",
          status: resumed.run.status,
          message: "Approval received.",
          createdAt: new Date().toISOString()
        },
        resumed.run
      );
      await this.persistRunBundle(resumed.run, resumed.approvalTicket);
      await this.safeNotify(() =>
        this.notifier.notifyApprovalResolved(run.request, { ...resumed, approvalTicket: approvedTicket }, "approved")
      );
      if (!resumed.approvalTicket) {
        await this.safeNotify(() => this.notifier.notifyRunSettled(run.request, resumed.run));
      }
      return {
        token,
        run: resumed.run,
        approvalTicket: resumed.approvalTicket
      };
    });
  }

  async denyTicket(ticketId: string) {
    return this.runDesktopWork(async () => {
      const ticket = this.state.approvals.get(ticketId) ?? (await this.persistence.getApproval(ticketId));
      if (!ticket) {
        throw new Error(`Approval ticket ${ticketId} not found.`);
      }

      const run = this.state.runs.get(ticket.runId) ?? (await this.persistence.getRun(ticket.runId));
      this.assertPendingTicket(ticket);

      if (run) {
        this.assertRunAwaitingApproval(run, ticket.id);
      }

      const deniedTicket: ApprovalTicket = {
        ...ticket,
        state: "denied"
      };
      this.state.approvals.set(ticket.id, deniedTicket);
      await this.persistence.saveApproval(deniedTicket);

      if (run) {
        const blockedRun: TaskRun = {
          ...run,
          status: "blocked",
          outcomeSummary: `Approval ticket ${ticket.id} was denied.`,
          updatedAt: new Date().toISOString()
        };
        await this.recordRunEvent(
          {
            eventId: randomUUID(),
            runId: blockedRun.runId,
            kind: "approval.resolved",
            status: blockedRun.status,
            message: blockedRun.outcomeSummary ?? "Approval denied.",
            createdAt: blockedRun.updatedAt
          },
          blockedRun
        );
        this.state.runs.set(blockedRun.runId, blockedRun);
        await this.persistence.saveRun(blockedRun);
        await this.safeNotify(() =>
          this.notifier.notifyApprovalResolved(run.request, { run: blockedRun, approvalTicket: deniedTicket }, "denied")
        );
        await this.safeNotify(() => this.notifier.notifyRunSettled(run.request, blockedRun));
        return blockedRun;
      }

      return undefined;
    });
  }

  async ingestNotification(signal: NotificationSignal) {
    const result = this.inboxEngine.acceptNotification(signal);
    if (!result.item) {
      return { ignored: true };
    }

    if (result.followup) {
      const created = await this.createTask(result.followup);
      result.item.linkedRunId = created.run.runId;
    }

    this.inboxEngine.upsert(result.item);
    await this.persistence.saveInboxItem(result.item);
    return result;
  }

  async deriveCandidate(
    params: Parameters<EvolutionLab["deriveCandidate"]>[0]
  ) {
    const candidate = this.skillRegistry.stageCandidate(this.evolutionLab.deriveCandidate(params));
    await this.persistence.saveCapabilityCandidate(candidate);
    return candidate;
  }

  async reviewStagingCandidate(params: { id: string; notes?: string; observationWindowPassed: boolean }) {
    const reviewed = this.skillRegistry.reviewStaging(
      params.id,
      params.observationWindowPassed,
      params.notes
    );
    if (!reviewed) {
      throw new Error(`Staging candidate ${params.id} not found.`);
    }

    await this.persistence.saveCapabilityCandidate(reviewed);
    return reviewed;
  }

  async listCapabilityCandidates() {
    const registry = this.skillRegistry.snapshot();
    return [...registry.staging, ...registry.stable, ...registry.held] satisfies CapabilityCandidate[];
  }

  listChatPlugins() {
    return [...this.chatPlugins];
  }

  async listRuns() {
    return [...this.state.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRun(runId: string) {
    return this.state.runs.get(runId) ?? this.persistence.getRun(runId);
  }

  async listRunEvents(runId: string) {
    return this.persistence.listRunEvents(runId);
  }

  async listApprovals() {
    return [...this.state.approvals.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  private async loadState() {
    const [runs, approvals, inboxItems, candidates] = await Promise.all([
      this.persistence.listRuns(),
      this.persistence.listApprovals(),
      this.persistence.listInboxItems(),
      this.persistence.listCapabilityCandidates()
    ]);

    this.state.runs.clear();
    this.state.approvals.clear();
    this.state.runsByRequestKey.clear();
    for (const run of runs) {
      this.state.runs.set(run.runId, run);
      this.state.runsByRequestKey.set(this.requestKey(run.request), run.runId);
    }
    for (const approval of approvals) {
      this.state.approvals.set(approval.id, approval);
    }

    this.inboxEngine.hydrate(inboxItems);
    this.skillRegistry.hydrate(candidates);
    await this.reconcileRecoveredState();
  }

  private async persistRunBundle(run: TaskRun, approvalTicket?: ApprovalTicket) {
    this.state.runs.set(run.runId, run);
    this.state.runsByRequestKey.set(this.requestKey(run.request), run.runId);
    await this.persistence.saveRun(run);

    if (approvalTicket) {
      this.state.approvals.set(approvalTicket.id, approvalTicket);
      await this.persistence.saveApproval(approvalTicket);
    }
  }

  private async notifyTaskCreated(request: TaskRequest, run: TaskRun, approvalTicket?: ApprovalTicket) {
    if (approvalTicket) {
      this.safeNotify(() =>
        this.notifier.notifyApprovalRequested(request, {
          run,
          approvalTicket
        })
      );
      return;
    }

    this.safeNotify(() => this.notifier.notifyRunSettled(request, run));
  }

  private safeNotify(task: () => Promise<void>) {
    void Promise.resolve()
      .then(task)
      .catch((error) => {
        console.warn(
          `Notifier error: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private async recordRunEvent(event: RunEvent, run: TaskRun) {
    this.state.runs.set(run.runId, run);
    this.state.runsByRequestKey.set(this.requestKey(run.request), run.runId);
    await this.persistence.saveRun(run);
    await this.persistence.saveRunEvent(event);
    this.eventBus?.emit({
      type: "run.event",
      event,
      run
    });
    this.safeNotify(() => this.notifier.notifyRunEvent(run.request, run, event));
  }

  private async runDesktopWork<T>(work: () => Promise<T>) {
    const previous = this.desktopQueue;
    let release = () => {};
    this.desktopQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private requestKey(request: TaskRequest) {
    return `${request.source}:${request.id}`;
  }

  private findPendingApprovalForRun(runId: string) {
    return [...this.state.approvals.values()]
      .filter((ticket) => ticket.runId === runId && ticket.state === "pending")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  private assertPendingTicket(ticket: ApprovalTicket) {
    if (ticket.state !== "pending") {
      throw new Error(`Approval ticket ${ticket.id} is already ${ticket.state}.`);
    }
  }

  private assertRunAwaitingApproval(run: TaskRun, ticketId: string) {
    if (run.status !== "awaiting_approval") {
      throw new Error(`Task run ${run.runId} is not awaiting approval for ticket ${ticketId}.`);
    }
  }

  private async reconcileRecoveredState() {
    const recoveredAt = new Date().toISOString();
    const pendingApprovalRunIds = new Set<string>();

    for (const approval of [...this.state.approvals.values()]) {
      if (approval.state !== "pending") {
        continue;
      }

      pendingApprovalRunIds.add(approval.runId);
      const expiredTicket: ApprovalTicket = {
        ...approval,
        state: "expired"
      };
      this.state.approvals.set(expiredTicket.id, expiredTicket);
      await this.persistence.saveApproval(expiredTicket);
    }

    for (const run of [...this.state.runs.values()]) {
      if (!IN_FLIGHT_RUN_STATUSES.has(run.status)) {
        continue;
      }

      const reconciledRun = this.reconcileRecoveredRun(run, recoveredAt, pendingApprovalRunIds.has(run.runId));
      this.state.runs.set(reconciledRun.runId, reconciledRun);
      this.state.runsByRequestKey.set(this.requestKey(reconciledRun.request), reconciledRun.runId);
      await this.persistence.saveRun(reconciledRun);

      const reconciliationEvent: RunEvent = {
        eventId: randomUUID(),
        runId: reconciledRun.runId,
        kind: "run.note",
        status: reconciledRun.status,
        stepId: reconciledRun.currentStepId,
        message: reconciledRun.outcomeSummary ?? "Recovered interrupted run state after daemon restart.",
        createdAt: recoveredAt
      };
      await this.persistence.saveRunEvent(reconciliationEvent);

      this.safeNotify(() => this.notifier.notifyRunEvent(reconciledRun.request, reconciledRun, reconciliationEvent));
      this.safeNotify(() => this.notifier.notifyRunSettled(reconciledRun.request, reconciledRun));
    }
  }

  private reconcileRecoveredRun(run: TaskRun, recoveredAt: string, hadPendingApproval: boolean): TaskRun {
    if (run.status === "awaiting_approval") {
      return {
        ...run,
        status: "blocked",
        outcomeSummary: hadPendingApproval
          ? "Daemon restarted while waiting for approval. The pending approval ticket was expired; review the desktop state and retry the task."
          : "Daemon restarted while the task was waiting for approval. Review the desktop state and retry the task.",
        updatedAt: recoveredAt
      };
    }

    return {
      ...run,
      status: "failed",
      outcomeSummary: `Daemon restarted while the task was in progress (previous status: ${run.status}). Review the desktop state and retry the task.`,
      updatedAt: recoveredAt
    };
  }

  private async handleLine(line: string): Promise<JsonRpcResponse> {
    try {
      const request = jsonRpcRequestSchema.parse(JSON.parse(line)) as JsonRpcRequest;
      const result = await this.route(request.method, request.params);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: "unknown",
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Unknown RPC error"
        }
      };
    }
  }

  private async route(method: string, params: unknown) {
    switch (method) {
      case "health.ping":
        return {
          ok: true,
          now: new Date().toISOString(),
          persistence: this.persistence.backend
        };
      case "bridge.capabilities":
        return this.bridgeClient.describeCapabilities();
      case "models.list":
        return this.modelRouter.listProfiles();
      case "runtime.readiness":
        return this.runtimeReadinessProvider ? this.runtimeReadinessProvider() : undefined;
      case "skills.list":
        return this.skillRegistry.snapshot();
      case "chat.plugins.list":
        return this.listChatPlugins();
      case "inbox.list":
        return this.inboxEngine.list();
      case "notification.ingest":
        return this.ingestNotification(params as NotificationSignal);
      case "task.create":
        return this.createTask(params as TaskRequest);
      case "run.get":
        return this.getRun((params as { runId: string }).runId);
      case "run.list":
        return this.listRuns();
      case "run.events":
        return this.listRunEvents((params as { runId: string }).runId);
      case "approval.list":
        return this.listApprovals();
      case "approval.approve": {
        const { ticketId, approvedBy } = params as { approvedBy: string; ticketId: string };
        return this.approveTicket(ticketId, approvedBy);
      }
      case "approval.deny": {
        const { ticketId } = params as { ticketId: string };
        return this.denyTicket(ticketId);
      }
      case "evolution.derive":
        return this.deriveCandidate(params as Parameters<EvolutionLab["deriveCandidate"]>[0]);
      case "evolution.list":
        return this.listCapabilityCandidates();
      case "evolution.reviewStaging":
      case "evolution.promoteStaging":
        return this.reviewStagingCandidate(
          params as {
            id: string;
            notes?: string;
            observationWindowPassed: boolean;
          }
        );
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }
}

import { randomUUID } from "node:crypto";
import type { ApprovalTicket, MessageBinding, RunEvent, TaskRequest, TaskRun } from "@lobster/shared";
import type { RuntimePersistence } from "@lobster/storage";
import type { TelegramRuntimeConfig } from "./telegramConfig.js";
import {
  editTelegramTextMessage,
  sendTelegramTextMessage,
  type TelegramInlineKeyboardMarkup
} from "./telegramHttp.js";
import type { RuntimeNotifier } from "./runtimeNotifier.js";

type RuntimeTaskBundle = {
  approvalTicket?: ApprovalTicket;
  run: TaskRun;
};

class TelegramBotClient {
  constructor(private readonly getOptions: () => { baseUrl: string; botToken?: string }) {}

  async sendText(chatId: string, text: string, replyMarkup?: TelegramInlineKeyboardMarkup) {
    const options = this.getOptions();
    if (!options.botToken) {
      return { messageId: "" };
    }
    return sendTelegramTextMessage({
      baseUrl: options.baseUrl,
      botToken: options.botToken,
      chatId,
      text,
      replyMarkup
    });
  }

  async editText(chatId: string, messageId: string, text: string, replyMarkup?: TelegramInlineKeyboardMarkup) {
    const options = this.getOptions();
    if (!options.botToken) {
      throw new Error("Telegram bot token is not configured.");
    }
    return editTelegramTextMessage({
      baseUrl: options.baseUrl,
      botToken: options.botToken,
      chatId,
      messageId,
      text,
      replyMarkup
    });
  }
}

class TelegramRuntimeNotifier implements RuntimeNotifier {
  constructor(
    private readonly client: TelegramBotClient,
    private readonly persistence: RuntimePersistence
  ) {}

  async notifyApprovalRequested(request: TaskRequest, bundle: RuntimeTaskBundle) {
    if (request.source !== "telegram" || !bundle.approvalTicket) {
      return;
    }

    await this.upsertStatusCard(request, bundle.run, bundle.approvalTicket, {
      eventId: randomUUID(),
      runId: bundle.run.runId,
      kind: "approval.requested",
      status: bundle.run.status,
      message: bundle.approvalTicket.reason,
      createdAt: new Date().toISOString()
    });
  }

  async notifyApprovalResolved(
    request: TaskRequest,
    bundle: RuntimeTaskBundle,
    decision: "approved" | "denied"
  ) {
    if (request.source !== "telegram") {
      return;
    }

    await this.upsertStatusCard(request, bundle.run, undefined, {
      eventId: randomUUID(),
      runId: bundle.run.runId,
      kind: "approval.resolved",
      status: bundle.run.status,
      message: decision === "approved" ? "Approval received." : "Approval denied.",
      createdAt: new Date().toISOString()
    });
  }

  async notifyRunEvent(request: TaskRequest, run: TaskRun, event: RunEvent) {
    if (request.source !== "telegram") {
      return;
    }

    await this.upsertStatusCard(request, run, undefined, event);
  }

  async notifyRunSettled(request: TaskRequest, run: TaskRun) {
    if (request.source !== "telegram") {
      return;
    }

    await this.upsertStatusCard(request, run, undefined, {
      eventId: randomUUID(),
      runId: run.runId,
      kind: "run.settled",
      status: run.status,
      message: run.outcomeSummary ?? describeRunStatus(run.status),
      createdAt: new Date().toISOString()
    });
  }

  private async upsertStatusCard(
    request: TaskRequest,
    run: TaskRun,
    approvalTicket: ApprovalTicket | undefined,
    event: RunEvent
  ) {
    const binding = await this.persistence.getMessageBinding(run.runId, "telegram", "status_card");
    const nextText = buildTaskCard({
      approvalTicket,
      event,
      request,
      run
    });
    const markup = buildApprovalMarkup(approvalTicket);

    if (!binding) {
      const sent = await this.client.sendText(request.userId, nextText, markup);
      const createdAt = new Date().toISOString();
      if (!sent.messageId) {
        return;
      }
      const nextBinding: MessageBinding = {
        id: randomUUID(),
        channel: "telegram",
        runId: run.runId,
        chatId: request.userId,
        messageId: sent.messageId,
        mode: "status_card",
        createdAt,
        updatedAt: createdAt
      };
      await this.persistence.saveMessageBinding(nextBinding);
      return;
    }

    try {
      await this.client.editText(binding.chatId, binding.messageId, nextText, markup);
      await this.persistence.saveMessageBinding({
        ...binding,
        updatedAt: new Date().toISOString()
      });
      return;
    } catch (error) {
      if (isNoopEdit(error)) {
        await this.persistence.saveMessageBinding({
          ...binding,
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const sent = await this.client.sendText(request.userId, nextText, markup);
      if (!sent.messageId) {
        return;
      }
      const reboundAt = new Date().toISOString();
      await this.persistence.saveMessageBinding({
        ...binding,
        chatId: request.userId,
        messageId: sent.messageId,
        updatedAt: reboundAt
      });
    }
  }
}

export function createTelegramRuntimeNotifierFromEnv(
  getConfig: () => TelegramRuntimeConfig,
  persistence: RuntimePersistence
): RuntimeNotifier {
  return new TelegramRuntimeNotifier(
    new TelegramBotClient(() => ({
      botToken: getConfig().botToken,
      baseUrl: getConfig().baseUrl.replace(/\/$/, "")
    })),
    persistence
  );
}

function buildTaskCard(params: {
  approvalTicket?: ApprovalTicket;
  event: RunEvent;
  request: TaskRequest;
  run: TaskRun;
}) {
  const { approvalTicket, event, request, run } = params;
  const currentStep = run.currentStepId ? run.plan.find((step) => step.id === run.currentStepId) : undefined;
  const currentIndex = currentStep ? run.plan.findIndex((step) => step.id === currentStep.id) + 1 : 0;
  const totalSteps = run.plan.length;

  const lines = [
    `Lobster Task ${shortId(run.runId)}`,
    `Status: ${run.status}`,
    totalSteps > 0 ? `Step: ${currentIndex}/${totalSteps}${currentStep ? ` - ${currentStep.title}` : ""}` : "Step: pending",
    `Task: ${request.text}`
  ];

  if (event.message.trim()) {
    lines.push(`Update: ${event.message.trim()}`);
  }
  if (!event.message.trim() && run.outcomeSummary?.trim()) {
    lines.push(`Summary: ${run.outcomeSummary.trim()}`);
  }

  if (run.verification) {
    lines.push(`Verification: ${run.verification.status}`);
    lines.push(`Why: ${run.verification.message}`);
    const evidenceSources = Array.from(new Set(run.verification.evidenceItems.map((item) => item.source)));
    const visionEvidence = run.verification.evidenceItems.find((item) => item.source === "vision");
    if (evidenceSources.length > 0) {
      lines.push(`Evidence: ${evidenceSources.join(" + ")}`);
    } else if (run.verification.evidence.length > 0) {
      lines.push(`Evidence: ${run.verification.evidence.slice(0, 2).join(" | ")}`);
    }
    if (visionEvidence?.confidence !== undefined) {
      lines.push(`Vision: ${visionEvidence.confidence.toFixed(2)}`);
    }
    if (visionEvidence?.screenshotRef) {
      lines.push(`Shot: ${visionEvidence.screenshotRef}`);
    }
  }

  if (run.latestObservation) {
    lines.push(
      `Observed: ${run.latestObservation.activeApp}${
        run.latestObservation.activeWindowTitle ? ` / ${run.latestObservation.activeWindowTitle}` : ""
      }`
    );
    if (run.latestObservation.focusedElement?.label) {
      lines.push(`Focused: ${run.latestObservation.focusedElement.label}`);
    }
    if (run.latestObservation.ocrText.length > 0) {
      lines.push(`OCR: ${run.latestObservation.ocrText.slice(0, 2).join(", ")}`);
    }
  }

  if (approvalTicket) {
    lines.push(`Approval: waiting (${approvalTicket.id})`);
    lines.push(`Action: ${approvalTicket.action.kind}`);
  } else if (run.status === "awaiting_approval") {
    lines.push("Approval: waiting");
  } else {
    lines.push("Approval: none");
  }

  return lines.join("\n");
}

function buildApprovalMarkup(approvalTicket?: ApprovalTicket): TelegramInlineKeyboardMarkup | undefined {
  if (!approvalTicket || approvalTicket.state !== "pending") {
    return undefined;
  }

  return {
    inline_keyboard: [
      [
        {
          text: "Approve once",
          callback_data: `tg:approve:${approvalTicket.id}`
        },
        {
          text: "Deny",
          callback_data: `tg:deny:${approvalTicket.id}`
        }
      ]
    ]
  };
}

function describeRunStatus(status: TaskRun["status"]) {
  switch (status) {
    case "completed":
      return "Completed.";
    case "blocked":
      return "Blocked.";
    case "awaiting_approval":
      return "Waiting for approval.";
    case "failed":
      return "Failed.";
    default:
      return `State changed to ${status}.`;
  }
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function isNoopEdit(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
}

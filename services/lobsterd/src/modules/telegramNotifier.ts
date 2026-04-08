import type { TaskRequest, TaskRun } from "@lobster/shared";
import type { ApprovalTicket } from "@lobster/shared";
import type { TelegramRuntimeConfig } from "./telegramConfig.js";
import { postTelegramJson } from "./telegramHttp.js";
import { NoopRuntimeNotifier, type RuntimeNotifier } from "./runtimeNotifier.js";

type TelegramSendResponse = {
  description?: string;
  ok: boolean;
};

type RuntimeTaskBundle = {
  approvalTicket?: ApprovalTicket;
  run: TaskRun;
};

class TelegramBotClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      botToken: string;
    }
  ) {}

  async sendText(chatId: string, text: string) {
    const response = await postTelegramJson<TelegramSendResponse>(
      `${this.options.baseUrl}/bot${this.options.botToken}/sendMessage`,
      {
        chat_id: chatId,
        text
      },
      {
        timeoutMs: 15000
      }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`);
    }
    const payload = response.payload;
    if (!payload.ok) {
      throw new Error(`Telegram sendMessage failed: ${payload.description ?? "unknown error"}`);
    }
  }
}

class TelegramRuntimeNotifier implements RuntimeNotifier {
  constructor(private readonly client: TelegramBotClient) {}

  async notifyApprovalRequested(request: TaskRequest, bundle: RuntimeTaskBundle) {
    if (request.source !== "telegram" || !bundle.approvalTicket) {
      return;
    }

    await this.client.sendText(
      request.userId,
      [
        "Lobster needs approval before continuing.",
        `Task: ${request.text}`,
        `Action: ${bundle.approvalTicket.action.kind}`,
        `Reason: ${bundle.approvalTicket.reason}`,
        `Ticket: ${bundle.approvalTicket.id}`,
        "Reply: /approve <ticketId> or /deny <ticketId>"
      ].join("\n")
    );
  }

  async notifyApprovalResolved(
    request: TaskRequest,
    bundle: RuntimeTaskBundle,
    decision: "approved" | "denied"
  ) {
    if (request.source !== "telegram") {
      return;
    }

    await this.client.sendText(
      request.userId,
      [
        `Lobster ${decision === "approved" ? "received approval" : "cancelled the task after denial"}.`,
        `Task: ${request.text}`,
        `Status: ${bundle.run.status}`
      ].join("\n")
    );
  }

  async notifyRunSettled(request: TaskRequest, run: TaskRun) {
    if (request.source !== "telegram") {
      return;
    }

    const lines = [`Lobster ${describeRunStatus(run.status)}.`, `Task: ${request.text}`, `Status: ${run.status}`];
    if (run.outcomeSummary) {
      lines.push(`Summary: ${run.outcomeSummary}`);
    }
    if (!run.outcomeSummary && run.selfCheck?.explanation && run.status !== "completed") {
      lines.push(`Reason: ${run.selfCheck.explanation}`);
    }

    await this.client.sendText(request.userId, lines.join("\n"));
  }
}

export function createTelegramRuntimeNotifierFromEnv(config: TelegramRuntimeConfig): RuntimeNotifier {
  if (!config.botToken) {
    return new NoopRuntimeNotifier();
  }

  return new TelegramRuntimeNotifier(
    new TelegramBotClient({
      botToken: config.botToken,
      baseUrl: config.baseUrl.replace(/\/$/, "")
    })
  );
}

function describeRunStatus(status: TaskRun["status"]) {
  switch (status) {
    case "completed":
      return "completed the task";
    case "blocked":
      return "refused the task";
    case "awaiting_approval":
      return "is waiting for approval";
    case "failed":
      return "failed the task";
    default:
      return `updated task state to ${status}`;
  }
}

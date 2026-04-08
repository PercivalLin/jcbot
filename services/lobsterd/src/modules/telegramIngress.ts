import { createHash } from "node:crypto";
import type { TaskRequest } from "@lobster/shared";
import type { TelegramRuntimeConfig } from "./telegramConfig.js";
import { formatNetworkError, inferTelegramTroubleshootingHint } from "./telegramDiagnostics.js";
import { postTelegramJson } from "./telegramHttp.js";

type TelegramUpdateResponse = {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
};

type TelegramUpdate = {
  callback_query?: {
    data?: string;
    from?: {
      id?: number | string;
    };
    id?: string;
    message?: {
      chat?: {
        id?: number | string;
      };
      message_id?: number;
    };
  };
  update_id: number;
  message?: {
    chat?: {
      id?: number | string;
    };
    message_id?: number;
    text?: string;
  };
};

type TelegramMessageEvent = {
  callbackQueryId?: string;
  chatId: string;
  eventId: string;
  messageId?: string;
  receivedAt: string;
  text: string;
};

export type TelegramIngressCommand =
  | {
      kind: "task.create";
      request: TaskRequest;
    }
  | {
      kind: "chat.message";
      chatId: string;
      eventId: string;
      text: string;
    }
  | {
      approvedBy: string;
      callbackQueryId?: string;
      chatId: string;
      kind: "approval.approve";
      ticketId: string;
    }
  | {
      callbackQueryId?: string;
      chatId: string;
      kind: "approval.deny";
      ticketId: string;
    }
  | {
      chatId: string;
      kind: "run.status";
      runId?: string;
    };

type TelegramIngressOptions = {
  config: TelegramRuntimeConfig;
  onCommand: (command: TelegramIngressCommand) => Promise<unknown>;
  offsetStore?: {
    get: (key: string) => Promise<string | undefined>;
    set: (key: string, value: string) => Promise<void>;
  };
};

type TelegramIngressHandle = {
  close: () => Promise<void>;
};

export async function startTelegramPollingIngress(
  options: TelegramIngressOptions
): Promise<TelegramIngressHandle> {
  const token = options.config.botToken?.trim();
  if (!token) {
    throw new Error("Missing LOBSTER_TELEGRAM_BOT_TOKEN.");
  }

  const baseUrl = options.config.baseUrl.replace(/\/$/, "");
  const offsetStateKey = buildTelegramOffsetStateKey(baseUrl, token);
  let active = true;
  let updateOffset = await loadPersistedOffset(options.offsetStore, offsetStateKey);
  let activePollAbort: AbortController | undefined;
  let printedHint = false;
  const allowedChats = options.config.allowedChatIds ? new Set(options.config.allowedChatIds) : undefined;

  const loop = async () => {
    while (active) {
      try {
        activePollAbort = new AbortController();
        const response = await postTelegramJson<TelegramUpdateResponse>(
          `${baseUrl}/bot${token}/getUpdates`,
          {
            offset: updateOffset,
            timeout: 20
          },
          {
            timeoutMs: 25000
          }
        );
        const payload = response.payload;
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Telegram getUpdates failed with HTTP ${response.status}.`);
        }
        if (!payload.ok) {
          throw new Error(`Telegram getUpdates failed: ${payload.description ?? "unknown error"}`);
        }

        for (const update of payload.result ?? []) {
          const nextOffset = Math.max(updateOffset, update.update_id + 1);
          const event = decodeTelegramUpdate(update, allowedChats);
          if (!event) {
            if (nextOffset !== updateOffset) {
              updateOffset = nextOffset;
              await persistOffset(options.offsetStore, offsetStateKey, updateOffset);
            }
            continue;
          }
          const command = normalizeTelegramCommandWithMode(event, options.config.textMode);
          traceTelegramIngress(
            `[ingress][telegram][recv] chat=${maskChatId(event.chatId)} text="${preview(event.text)}" command=${command.kind}`
          );
          await options.onCommand(command);
          if (nextOffset !== updateOffset) {
            updateOffset = nextOffset;
            await persistOffset(options.offsetStore, offsetStateKey, updateOffset);
          }
        }
      } catch (error) {
        if (!active || isAbortError(error)) {
          break;
        }
        console.warn(
          `telegram ingress poll error: ${formatNetworkError(error)}`
        );
        const hint = inferTelegramTroubleshootingHint(
          formatNetworkError(error),
          options.config.baseUrl
        );
        if (hint && !printedHint) {
          printedHint = true;
          console.warn(`telegram ingress hint: ${hint}`);
        }
        await sleep(options.config.pollIntervalMs);
      } finally {
        activePollAbort = undefined;
      }
    }
  };

  void loop();

  return {
    close: async () => {
      active = false;
      activePollAbort?.abort();
    }
  };
}

export function normalizeTelegramCommand(event: TelegramMessageEvent): TelegramIngressCommand {
  return normalizeTelegramCommandWithMode(event, "task");
}

export function normalizeTelegramCommandWithMode(
  event: TelegramMessageEvent,
  textMode: "task" | "chat" | "hybrid"
): TelegramIngressCommand {
  const callbackApproveMatch = event.text.match(/^tg:approve:([a-zA-Z0-9-]{6,})$/i);
  if (callbackApproveMatch?.[1]) {
    return {
      callbackQueryId: event.callbackQueryId,
      chatId: event.chatId,
      kind: "approval.approve",
      ticketId: callbackApproveMatch[1],
      approvedBy: event.chatId
    };
  }

  const callbackDenyMatch = event.text.match(/^tg:deny:([a-zA-Z0-9-]{6,})$/i);
  if (callbackDenyMatch?.[1]) {
    return {
      callbackQueryId: event.callbackQueryId,
      chatId: event.chatId,
      kind: "approval.deny",
      ticketId: callbackDenyMatch[1]
    };
  }

  const approveMatch = event.text.match(/^\s*\/?(?:approve|批准|同意)\s+([a-zA-Z0-9-]{6,})\s*$/i);
  if (approveMatch?.[1]) {
    return {
      callbackQueryId: event.callbackQueryId,
      chatId: event.chatId,
      kind: "approval.approve",
      ticketId: approveMatch[1],
      approvedBy: event.chatId
    };
  }

  const denyMatch = event.text.match(/^\s*\/?(?:deny|reject|拒绝)\s+([a-zA-Z0-9-]{6,})\s*$/i);
  if (denyMatch?.[1]) {
    return {
      callbackQueryId: event.callbackQueryId,
      chatId: event.chatId,
      kind: "approval.deny",
      ticketId: denyMatch[1]
    };
  }

  const statusMatch = event.text.match(/^\s*\/?(?:status|状态)(?:\s+([a-zA-Z0-9-]{6,}))?\s*$/i);
  if (statusMatch) {
    return {
      chatId: event.chatId,
      kind: "run.status",
      runId: statusMatch[1]?.trim() || undefined
    };
  }

  const taskPrefix = event.text.match(/^\s*\/(?:do|task|run)\s+([\s\S]+)$/i);
  if (taskPrefix?.[1]) {
    return toTaskCommand(event, taskPrefix[1].trim());
  }

  const chatPrefix = event.text.match(/^\s*\/(?:chat|ask)\s+([\s\S]+)$/i);
  if (chatPrefix?.[1]) {
    return toChatCommand(event, chatPrefix[1].trim());
  }

  if (textMode === "chat") {
    return toChatCommand(event, event.text);
  }
  if (textMode === "hybrid") {
    if (looksLikeTaskInstruction(event.text)) {
      return toTaskCommand(event, event.text);
    }
    return toChatCommand(event, event.text);
  }

  // task mode (default)
  return toTaskCommand(event, event.text);
}

function toTaskCommand(event: TelegramMessageEvent, text: string): TelegramIngressCommand {
  return {
    kind: "task.create",
    request: {
      id: event.eventId,
      source: "telegram",
      userId: event.chatId,
      text,
      attachments: [],
      riskPreference: "auto",
      createdAt: event.receivedAt
    }
  };
}

function toChatCommand(event: TelegramMessageEvent, text: string): TelegramIngressCommand {
  return {
    kind: "chat.message",
    chatId: event.chatId,
    eventId: event.eventId,
    text
  };
}

export function decodeTelegramUpdate(
  update: TelegramUpdate,
  allowedChatIds?: Set<string>
): TelegramMessageEvent | undefined {
  const callbackQuery = update.callback_query;
  if (callbackQuery?.id && callbackQuery.message?.chat?.id !== undefined && callbackQuery.data?.trim()) {
    const chatId = String(callbackQuery.message.chat.id);
    if (allowedChatIds && !allowedChatIds.has(chatId)) {
      return undefined;
    }

    return {
      callbackQueryId: callbackQuery.id,
      chatId,
      eventId: String(update.update_id),
      messageId:
        callbackQuery.message.message_id !== undefined ? String(callbackQuery.message.message_id) : undefined,
      text: callbackQuery.data.trim(),
      receivedAt: new Date().toISOString()
    };
  }

  const text = update.message?.text?.trim();
  const chatIdValue = update.message?.chat?.id;
  if (!text || chatIdValue === undefined || chatIdValue === null) {
    return undefined;
  }

  const chatId = String(chatIdValue);
  if (allowedChatIds && !allowedChatIds.has(chatId)) {
    return undefined;
  }

  return {
    chatId,
    eventId: String(update.update_id),
    messageId: update.message?.message_id !== undefined ? String(update.message.message_id) : undefined,
    text,
    receivedAt: new Date().toISOString()
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function loadPersistedOffset(
  offsetStore: TelegramIngressOptions["offsetStore"],
  key: string
) {
  if (!offsetStore) {
    return 0;
  }

  const raw = await offsetStore.get(key);
  if (!raw) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function persistOffset(
  offsetStore: TelegramIngressOptions["offsetStore"],
  key: string,
  offset: number
) {
  if (!offsetStore) {
    return;
  }

  await offsetStore.set(key, String(offset));
}

function buildTelegramOffsetStateKey(baseUrl: string, token: string) {
  const tokenHash = createHash("sha1").update(token).digest("hex").slice(0, 12);
  return `telegram.offset.${tokenHash}.${baseUrl}`;
}

function looksLikeTaskInstruction(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/(打开|点击|输入|切换|上传|发送|删除|执行|运行|搜索|查找|启动|关闭)/.test(text)) {
    return true;
  }
  if (/(open|click|type|switch|upload|send|delete|run|execute|search|find|launch|close)\b/i.test(normalized)) {
    return true;
  }
  if (/(给.*发消息|发消息给|send.*to|message.*to)/i.test(text)) {
    return true;
  }
  return false;
}

function traceTelegramIngress(message: string) {
  if (process.env.LOBSTER_TELEGRAM_TRACE === "0") {
    return;
  }
  console.log(message);
}

function preview(text: string, max = 180) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function maskChatId(chatId: string) {
  const trimmed = chatId.trim();
  if (trimmed.length <= 6) {
    return trimmed;
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

import { resolveTelegramRuntimeConfig } from "../modules/telegramConfig.js";
import {
  formatNetworkError,
  inferTelegramTroubleshootingHint,
  normalizeTelegramBaseUrl,
  validateTelegramBaseUrl
} from "../modules/telegramDiagnostics.js";
import { postTelegramJson } from "../modules/telegramHttp.js";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";

type TelegramGetMeResponse = {
  ok: boolean;
  result?: {
    first_name?: string;
    id?: number;
    is_bot?: boolean;
    username?: string;
  };
  description?: string;
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
      type?: string;
      title?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

type KnownChat = {
  id: string;
  label: string;
  type: string;
  preview: string;
};

async function main() {
  loadRuntimeEnvFile();

  const config = resolveTelegramRuntimeConfig();
  if (!config.botToken) {
    console.log("Telegram token is missing.");
    console.log("");
    console.log("Set token first:");
    console.log("export LOBSTER_TELEGRAM_BOT_TOKEN=<bot_token_from_botfather>");
    console.log("");
    console.log("Then run:");
    console.log("pnpm --filter lobsterd run telegram:whoami");
    process.exitCode = 1;
    return;
  }

  const baseUrlIssue = validateTelegramBaseUrl(config.baseUrl);
  if (baseUrlIssue) {
    console.error(`Telegram quickstart failed: ${baseUrlIssue}`);
    console.error("Hint: use host prefix only, for example https://api.telegram.org");
    process.exitCode = 1;
    return;
  }

  const baseUrl = normalizeTelegramBaseUrl(config.baseUrl);

  try {
    const bot = await telegramCall<TelegramGetMeResponse>(
      `${baseUrl}/bot${config.botToken}/getMe`,
      undefined
    );
    if (!bot.ok || !bot.result) {
      throw new Error(bot.description ?? "Telegram getMe returned not ok.");
    }

    const name = bot.result.first_name ?? "unknown";
    const username = bot.result.username ? `@${bot.result.username}` : "(no username)";
    console.log(`Telegram bot connected: ${name} ${username}`);
    console.log(`Bot id: ${bot.result.id ?? "unknown"}`);

    const updates = await telegramCall<TelegramGetUpdatesResponse>(
      `${baseUrl}/bot${config.botToken}/getUpdates`,
      {
        offset: 0,
        limit: 30,
        timeout: 0,
        allowed_updates: ["message"]
      }
    );
    if (!updates.ok) {
      throw new Error(updates.description ?? "Telegram getUpdates returned not ok.");
    }

    const chats = collectChats(updates.result ?? []);
    console.log("");
    if (chats.length === 0) {
      console.log("No recent chat found in getUpdates.");
      console.log("1) Open Telegram and send any message to your bot");
      console.log("2) Re-run this command");
      process.exitCode = 0;
      return;
    }

    console.log("Detected chats:");
    for (const chat of chats) {
      console.log(`- ${chat.id} [${chat.type}] ${chat.label} | preview: ${chat.preview}`);
    }

    const allowlist = chats.map((chat) => chat.id).join(",");
    console.log("");
    console.log("Recommended hardening:");
    console.log(`export LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS=${allowlist}`);
    console.log("");
    console.log("Start daemon:");
    console.log("pnpm dev:daemon");
  } catch (error) {
    const message = formatNetworkError(error);
    console.error(`Telegram quickstart failed: ${message}`);
    const hint = inferTelegramTroubleshootingHint(message, config.baseUrl);
    if (hint) {
      console.error(`Hint: ${hint}`);
    }
    process.exitCode = 1;
  }
}

async function telegramCall<T>(url: string, body: Record<string, unknown> | undefined): Promise<T> {
  try {
    const response = await postTelegramJson<T>(url, body ?? {}, {
      timeoutMs: 12000
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.payload;
  } catch (error) {
    throw new Error(formatNetworkError(error));
  }
}

function collectChats(updates: TelegramUpdate[]): KnownChat[] {
  const map = new Map<string, KnownChat>();

  for (const update of updates) {
    const chat = update.message?.chat;
    if (!chat || chat.id === undefined || chat.id === null) {
      continue;
    }

    const id = String(chat.id);
    if (map.has(id)) {
      continue;
    }

    const label = resolveChatLabel(chat);
    const type = chat.type?.trim() || "unknown";
    const previewRaw = update.message?.text?.trim() || "(non-text message)";
    const preview = previewRaw.length > 40 ? `${previewRaw.slice(0, 37)}...` : previewRaw;
    map.set(id, {
      id,
      label,
      type,
      preview
    });
  }

  return Array.from(map.values());
}

function resolveChatLabel(chat: NonNullable<TelegramUpdate["message"]>["chat"]) {
  const title = chat?.title?.trim();
  if (title) {
    return title;
  }

  const username = chat?.username?.trim();
  if (username) {
    return `@${username}`;
  }

  const first = chat?.first_name?.trim();
  const last = chat?.last_name?.trim();
  const full = [first, last].filter(Boolean).join(" ");
  return full || "(no label)";
}

void main();

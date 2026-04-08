export type TelegramRuntimeConfig = {
  allowedChatIds?: string[];
  baseUrl: string;
  botToken?: string;
  pollIntervalMs: number;
  textMode: "task" | "chat" | "hybrid";
};

export function resolveTelegramRuntimeConfig(): TelegramRuntimeConfig {
  const pollIntervalRaw = Number(process.env.LOBSTER_TELEGRAM_POLL_INTERVAL_MS ?? 1500);
  const pollIntervalMs = Number.isFinite(pollIntervalRaw) && pollIntervalRaw > 200 ? Math.floor(pollIntervalRaw) : 1500;
  const textModeRaw = (process.env.LOBSTER_TELEGRAM_TEXT_MODE ?? "hybrid").trim().toLowerCase();
  const textMode = parseTelegramTextMode(textModeRaw);
  const allowedChatIds = process.env.LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    botToken: process.env.LOBSTER_TELEGRAM_BOT_TOKEN?.trim() || undefined,
    baseUrl: process.env.LOBSTER_TELEGRAM_BASE_URL?.trim() || "https://api.telegram.org",
    pollIntervalMs,
    textMode,
    allowedChatIds: allowedChatIds && allowedChatIds.length > 0 ? allowedChatIds : undefined
  };
}

function parseTelegramTextMode(value: string): "task" | "chat" | "hybrid" {
  if (value === "chat" || value === "hybrid") {
    return value;
  }
  return "task";
}

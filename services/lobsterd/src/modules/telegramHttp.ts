import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const HTTP_CODE_MARKER = "\n__LOBSTER_HTTP_CODE__:";

type CurlResponse = {
  bodyText: string;
  status: number;
};

type TelegramSendResponse = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
};

type TelegramEditResponse = TelegramSendResponse;
type TelegramCallbackResponse = {
  ok: boolean;
  description?: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
};

export function resolveTelegramProxyUrl() {
  const candidates = [
    process.env.LOBSTER_TELEGRAM_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export async function postTelegramJson<T>(
  url: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number }
) {
  const timeoutMs = Math.max(1000, options?.timeoutMs ?? 15000);
  const proxyUrl = resolveTelegramProxyUrl();
  const payloadText = JSON.stringify(body);

  if (proxyUrl) {
    const response = await postViaCurl(url, payloadText, timeoutMs, proxyUrl);
    return parseJsonResponse<T>(response.status, response.bodyText);
  }

  return postViaFetch<T>(url, payloadText, timeoutMs);
}

export async function sendTelegramTextMessage(options: {
  baseUrl: string;
  botToken: string;
  chatId: string;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}) {
  const { baseUrl, botToken, chatId, text, replyMarkup } = options;
  const safeText = text.length > 3500 ? `${text.slice(0, 3500)}…` : text;
  const response = await postTelegramJson<TelegramSendResponse>(
    `${baseUrl.replace(/\/$/, "")}/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text: safeText,
      reply_markup: replyMarkup
    },
    {
      timeoutMs: 15000
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`);
  }
  if (!response.payload.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.payload.description ?? "unknown error"}`);
  }

  return {
    messageId: String(response.payload.result?.message_id ?? "")
  };
}

export async function editTelegramTextMessage(options: {
  baseUrl: string;
  botToken: string;
  chatId: string;
  messageId: string;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}) {
  const { baseUrl, botToken, chatId, messageId, text, replyMarkup } = options;
  const safeText = text.length > 3500 ? `${text.slice(0, 3500)}…` : text;
  const response = await postTelegramJson<TelegramEditResponse>(
    `${baseUrl.replace(/\/$/, "")}/bot${botToken}/editMessageText`,
    {
      chat_id: chatId,
      message_id: Number.parseInt(messageId, 10),
      text: safeText,
      reply_markup: replyMarkup
    },
    {
      timeoutMs: 15000
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Telegram editMessageText failed with HTTP ${response.status}.`);
  }
  if (!response.payload.ok) {
    throw new Error(`Telegram editMessageText failed: ${response.payload.description ?? "unknown error"}`);
  }
}

export async function answerTelegramCallbackQuery(options: {
  baseUrl: string;
  botToken: string;
  callbackQueryId: string;
  text?: string;
}) {
  const response = await postTelegramJson<TelegramCallbackResponse>(
    `${options.baseUrl.replace(/\/$/, "")}/bot${options.botToken}/answerCallbackQuery`,
    {
      callback_query_id: options.callbackQueryId,
      text: options.text
    },
    {
      timeoutMs: 10000
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Telegram answerCallbackQuery failed with HTTP ${response.status}.`);
  }
  if (!response.payload.ok) {
    throw new Error(`Telegram answerCallbackQuery failed: ${response.payload.description ?? "unknown error"}`);
  }
}

async function postViaFetch<T>(url: string, payloadText: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: payloadText,
      signal: controller.signal
    });
    const bodyText = await response.text();
    return parseJsonResponse<T>(response.status, bodyText);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`telegram fetch request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonResponse<T>(status: number, bodyText: string) {
  let payload: T;
  try {
    payload = JSON.parse(bodyText) as T;
  } catch {
    throw new Error(`telegram http parse failed: status=${status}, body=${truncateBody(bodyText)}`);
  }

  return {
    payload,
    status
  };
}

async function postViaCurl(url: string, payloadText: string, timeoutMs: number, proxyUrl: string): Promise<CurlResponse> {
  const seconds = Math.max(2, Math.ceil(timeoutMs / 1000));
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    String(seconds),
    "--request",
    "POST",
    "--header",
    "content-type: application/json; charset=utf-8",
    "--connect-timeout",
    "8",
    "--retry",
    "2",
    "--retry-all-errors",
    "--retry-delay",
    "1",
    "--proxy",
    proxyUrl,
  ];

  const extraCaCerts = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (extraCaCerts && existsSync(extraCaCerts)) {
    args.push("--cacert", extraCaCerts);
  }

  if (isTlsInsecureEnabled()) {
    args.push("--insecure");
  }

  if (isTruthy(process.env.LOBSTER_TELEGRAM_PROXY_INSECURE)) {
    args.push("--proxy-insecure");
  }

  args.push(
    "--data",
    payloadText,
    "--write-out",
    HTTP_CODE_MARKER + "%{http_code}",
    url
  );

  const { code, stderr, stdout } = await spawnAndCollect("curl", args);
  if (code !== 0) {
    const detail = stderr.trim() || truncateBody(stdout);
    throw new Error(`telegram curl request failed (exit=${code}): ${detail}`);
  }

  const markerIndex = stdout.lastIndexOf(HTTP_CODE_MARKER);
  if (markerIndex === -1) {
    throw new Error(`telegram curl response missing http code marker: ${truncateBody(stdout)}`);
  }

  const bodyText = stdout.slice(0, markerIndex);
  const statusRaw = stdout.slice(markerIndex + HTTP_CODE_MARKER.length).trim();
  const status = Number.parseInt(statusRaw, 10);
  if (!Number.isFinite(status)) {
    throw new Error(`telegram curl response status invalid: ${statusRaw}`);
  }

  return {
    bodyText,
    status
  };
}

function isTlsInsecureEnabled() {
  return isTruthy(process.env.LOBSTER_TELEGRAM_TLS_INSECURE) || isTruthy(process.env.LOBSTER_TLS_INSECURE);
}

function isTruthy(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function spawnAndCollect(command: string, args: string[]) {
  return new Promise<{
    code: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code,
        stderr,
        stdout
      });
    });
  });
}

function truncateBody(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 200) {
    return trimmed;
  }
  return `${trimmed.slice(0, 200)}...`;
}

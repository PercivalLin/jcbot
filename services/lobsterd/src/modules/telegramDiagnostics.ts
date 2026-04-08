import type { TelegramRuntimeConfig } from "./telegramConfig.js";
import { postTelegramJson } from "./telegramHttp.js";

type TelegramGetMeResponse = {
  ok: boolean;
  result?: {
    id?: number;
    username?: string;
    first_name?: string;
  };
  description?: string;
};

export type TelegramConnectivityProbe = {
  ok: boolean;
  message: string;
  hint?: string;
};

export function normalizeTelegramBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/$/, "");
}

export function validateTelegramBaseUrl(baseUrl: string): string | undefined {
  const normalized = normalizeTelegramBaseUrl(baseUrl);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "LOBSTER_TELEGRAM_BASE_URL is not a valid URL.";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "LOBSTER_TELEGRAM_BASE_URL must start with https:// or http://.";
  }

  const pathname = parsed.pathname.toLowerCase();
  if (pathname.includes("/bot")) {
    return "LOBSTER_TELEGRAM_BASE_URL should not include `/bot<token>`; keep only host prefix.";
  }

  if (/(getupdates|getme|sendmessage)/i.test(pathname)) {
    return "LOBSTER_TELEGRAM_BASE_URL should not include API method path.";
  }

  return undefined;
}

export function formatNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  if (!cause || typeof cause !== "object") {
    return error.message;
  }

  const details: string[] = [];
  const maybe = cause as {
    code?: string | number;
    errno?: string | number;
    host?: string;
    hostname?: string;
    message?: string;
    syscall?: string;
  };
  if (maybe.code !== undefined) {
    details.push(`code=${String(maybe.code)}`);
  }
  if (maybe.errno !== undefined) {
    details.push(`errno=${String(maybe.errno)}`);
  }
  if (maybe.syscall) {
    details.push(`syscall=${maybe.syscall}`);
  }
  if (maybe.hostname || maybe.host) {
    details.push(`host=${maybe.hostname ?? maybe.host}`);
  }
  if (maybe.message && maybe.message !== error.message) {
    details.push(maybe.message);
  }

  return details.length > 0 ? `${error.message} (${details.join(", ")})` : error.message;
}

export function inferTelegramTroubleshootingHint(message: string, baseUrl: string) {
  if (/ENOTFOUND|EAI_AGAIN|Could not resolve host|dns/i.test(message)) {
    return "DNS cannot resolve Telegram host. Configure system DNS/proxy, or set LOBSTER_TELEGRAM_BASE_URL to a reachable Bot API endpoint.";
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused. Verify ${normalizeTelegramBaseUrl(baseUrl)} is reachable and serving Telegram Bot API.`;
  }
  if (/ETIMEDOUT|timeout/i.test(message)) {
    return "Network timeout. Check firewall/proxy or unstable connection to Telegram API.";
  }
  if (/SSL_ERROR_SYSCALL|LibreSSL|SSL_connect|certificate|tls/i.test(message)) {
    return "TLS 握手失败。检查代理协议/端口是否正确，或配置 NODE_EXTRA_CA_CERTS；临时排障可设置 LOBSTER_TELEGRAM_TLS_INSECURE=1。";
  }
  if (/aborted|AbortError|This operation was aborted/i.test(message)) {
    return "Telegram API request timed out/aborted. Check outbound network path or increase timeout when diagnosing.";
  }
  if (/Unauthorized|HTTP 401|401/i.test(message)) {
    return "Bot token is invalid or revoked. Regenerate token via BotFather and update LOBSTER_TELEGRAM_BOT_TOKEN.";
  }
  if (/HTTP 404|404/i.test(message)) {
    return "Base URL path is likely wrong. Keep only host prefix (for example https://api.telegram.org).";
  }
  return undefined;
}

export async function probeTelegramConnectivity(
  config: TelegramRuntimeConfig,
  options?: { timeoutMs?: number }
): Promise<TelegramConnectivityProbe> {
  const botToken = config.botToken?.trim();
  if (!botToken) {
    return {
      ok: false,
      message: "LOBSTER_TELEGRAM_BOT_TOKEN is missing.",
      hint: "Set token first, then retry."
    };
  }

  const baseUrlIssue = validateTelegramBaseUrl(config.baseUrl);
  if (baseUrlIssue) {
    return {
      ok: false,
      message: baseUrlIssue,
      hint: "Use host prefix only, for example `https://api.telegram.org`."
    };
  }

  const timeoutMs = Math.max(1000, options?.timeoutMs ?? 8000);
  const baseUrl = normalizeTelegramBaseUrl(config.baseUrl);

  try {
    const response = await postTelegramJson<TelegramGetMeResponse>(
      `${baseUrl}/bot${botToken}/getMe`,
      {},
      {
        timeoutMs
      }
    );

    if (response.status < 200 || response.status >= 300) {
      const message = `Telegram getMe failed with HTTP ${response.status}.`;
      return {
        ok: false,
        message,
        hint: inferTelegramTroubleshootingHint(message, baseUrl)
      };
    }

    const payload = response.payload;
    if (!payload.ok || !payload.result) {
      const message = `Telegram getMe failed: ${payload.description ?? "unknown error"}`;
      return {
        ok: false,
        message,
        hint: inferTelegramTroubleshootingHint(message, baseUrl)
      };
    }

    const botLabel = payload.result.username
      ? `@${payload.result.username}`
      : payload.result.first_name ?? `id=${payload.result.id ?? "unknown"}`;
    return {
      ok: true,
      message: `Telegram API reachable, bot identity: ${botLabel}`
    };
  } catch (error) {
    const message = formatNetworkError(error);
    return {
      ok: false,
      message,
      hint: inferTelegramTroubleshootingHint(message, baseUrl)
    };
  }
}

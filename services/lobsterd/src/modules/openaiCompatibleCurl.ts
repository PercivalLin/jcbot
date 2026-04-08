import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ModelProfile } from "@lobster/shared";

const HTTP_CODE_MARKER = "\n__LOBSTER_HTTP_CODE__:";

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
};

type CurlResponse = {
  bodyText: string;
  status: number;
};

export async function promptOpenAICompatibleViaCurl(options: {
  apiKey?: string;
  profile: ModelProfile;
  prompt: string;
  timeoutMs: number;
}) {
  const { apiKey, profile, prompt, timeoutMs } = options;
  if (profile.provider !== "openai-compatible") {
    throw new Error("profile provider must be openai-compatible for curl fallback");
  }

  if (!profile.baseURL?.trim()) {
    throw new Error("openai-compatible profile requires baseURL for curl fallback");
  }

  const endpoint = `${profile.baseURL.replace(/\/$/, "")}/chat/completions`;
  const payloadText = JSON.stringify({
    max_tokens: profile.budget.outputTokens,
    messages: [{ role: "user", content: prompt }],
    model: profile.modelId,
    temperature: 0
  });

  const response = await postViaCurl({
    apiKey,
    payloadText,
    timeoutMs,
    url: endpoint
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`openai-compatible curl failed with HTTP ${response.status}: ${truncateBody(response.bodyText)}`);
  }

  let payload: OpenAICompatibleResponse;
  try {
    payload = JSON.parse(response.bodyText) as OpenAICompatibleResponse;
  } catch {
    throw new Error(`openai-compatible curl parse failed: ${truncateBody(response.bodyText)}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  if (payload.error?.message) {
    throw new Error(`openai-compatible error: ${payload.error.message}`);
  }

  throw new Error("openai-compatible response did not contain text content");
}

async function postViaCurl(options: {
  apiKey?: string;
  payloadText: string;
  timeoutMs: number;
  url: string;
}): Promise<CurlResponse> {
  const { apiKey, payloadText, timeoutMs, url } = options;
  const boundedTimeoutMs = Math.max(1_000, timeoutMs);
  const seconds = Math.max(1, Math.ceil(boundedTimeoutMs / 1000));
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
    String(Math.max(1, Math.min(8, seconds)))
  ];

  if (apiKey?.trim()) {
    args.push("--header", `Authorization: Bearer ${apiKey.trim()}`);
  }

  const proxyUrl = resolveProxyUrl();
  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  }

  const extraCaCerts = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (extraCaCerts && existsSync(extraCaCerts)) {
    args.push("--cacert", extraCaCerts);
  }

  if (process.env.LOBSTER_TLS_INSECURE === "1") {
    args.push("--insecure");
  }

  args.push(
    "--data",
    payloadText,
    "--write-out",
    HTTP_CODE_MARKER + "%{http_code}",
    url
  );

  const { code, stderr, stdout } = await spawnAndCollect("curl", args, boundedTimeoutMs);
  if (code !== 0) {
    const detail = stderr.trim() || truncateBody(stdout);
    throw new Error(`openai-compatible curl request failed (exit=${code}): ${detail}`);
  }

  const markerIndex = stdout.lastIndexOf(HTTP_CODE_MARKER);
  if (markerIndex === -1) {
    throw new Error(`openai-compatible curl response missing http code marker: ${truncateBody(stdout)}`);
  }

  const bodyText = stdout.slice(0, markerIndex);
  const statusRaw = stdout.slice(markerIndex + HTTP_CODE_MARKER.length).trim();
  const status = Number.parseInt(statusRaw, 10);
  if (!Number.isFinite(status)) {
    throw new Error(`openai-compatible curl response status invalid: ${statusRaw}`);
  }

  return { bodyText, status };
}

function resolveProxyUrl() {
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

function spawnAndCollect(command: string, args: string[], timeoutMs: number) {
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
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;

    const finishResolve = (value: { code: number | null; stderr: string; stdout: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }
      resolve(value);
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillHandle = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
      forceKillHandle.unref?.();
      finishReject(new Error(`openai-compatible curl request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    child.on("error", (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code) => {
      finishResolve({ code, stderr, stdout });
    });
  });
}

function truncateBody(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 240) {
    return trimmed;
  }
  return `${trimmed.slice(0, 240)}...`;
}

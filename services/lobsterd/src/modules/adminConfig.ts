import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import type { ModelProfile } from "@lobster/shared";
import { loadModelProfilesOrDefault } from "./config.js";
import { resolveWorkspaceConfigFile } from "./paths.js";
import { parseEnvFile, resolveRuntimeEnvPath } from "./runtimeEnv.js";

const RUNTIME_ENV_PATH = resolveRuntimeEnvPath();
const MODELS_PATH = resolveWorkspaceConfigFile({
  importMetaUrl: import.meta.url,
  name: "models.yaml",
  override: process.env.LOBSTER_MODELS_PATH
});
const CHAT_PLUGINS_PATH = resolveWorkspaceConfigFile({
  importMetaUrl: import.meta.url,
  name: "chat_plugins.yaml",
  override: process.env.LOBSTER_CHAT_PLUGINS_PATH
});
const CONFIG_DIR = dirname(RUNTIME_ENV_PATH);
const SECRETS_DIR = join(CONFIG_DIR, "secrets");
const TELEGRAM_TOKEN_FILE = join(SECRETS_DIR, "telegram_bot_token.txt");
const OPENAI_COMPATIBLE_API_KEY_FILE = join(SECRETS_DIR, "openai_compatible_api_key.txt");

export type AdminRuntimeConfig = {
  adminPort: number;
  bridgeBin: string;
  dataPath: string;
  socketPath: string;
  telegramAllowedChatIds: string[];
  telegramBaseUrl: string;
  telegramPollIntervalMs: number;
  telegramTextMode: "task" | "chat" | "hybrid";
};

export type AdminConfigSnapshot = {
  paths: {
    chatPluginsPath: string;
    modelsPath: string;
    runtimeEnvPath: string;
  };
  models: Record<ModelProfile["role"], ModelProfile>;
  runtime: AdminRuntimeConfig;
  secrets: {
    openaiCompatibleApiKeyConfigured: boolean;
    telegramBotTokenConfigured: boolean;
  };
};

export function readAdminConfigSnapshot(): AdminConfigSnapshot {
  const envMap = readRuntimeEnvMap();
  return {
    paths: {
      chatPluginsPath: CHAT_PLUGINS_PATH,
      modelsPath: MODELS_PATH,
      runtimeEnvPath: RUNTIME_ENV_PATH
    },
    models: loadModelProfilesOrDefault(MODELS_PATH),
    runtime: {
      adminPort: parsePositiveInteger(envMap.LOBSTER_ADMIN_PORT, 4545),
      bridgeBin: envMap.LOBSTER_BRIDGE_BIN ?? "",
      dataPath: envMap.LOBSTER_DATA_PATH ?? "/tmp/lobster/lobster.sqlite",
      socketPath: envMap.LOBSTER_SOCKET_PATH ?? "/tmp/lobster/lobsterd.sock",
      telegramAllowedChatIds: splitCsv(envMap.LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS),
      telegramBaseUrl: envMap.LOBSTER_TELEGRAM_BASE_URL ?? "https://api.telegram.org",
      telegramPollIntervalMs: parsePositiveInteger(envMap.LOBSTER_TELEGRAM_POLL_INTERVAL_MS, 1500),
      telegramTextMode: normalizeTextMode(envMap.LOBSTER_TELEGRAM_TEXT_MODE)
    },
    secrets: {
      openaiCompatibleApiKeyConfigured: resolveSecretConfigured(
        envMap.OPENAI_COMPATIBLE_API_KEY,
        envMap.OPENAI_COMPATIBLE_API_KEY_FILE,
        OPENAI_COMPATIBLE_API_KEY_FILE
      ),
      telegramBotTokenConfigured: resolveSecretConfigured(
        envMap.LOBSTER_TELEGRAM_BOT_TOKEN,
        envMap.LOBSTER_TELEGRAM_BOT_TOKEN_FILE,
        TELEGRAM_TOKEN_FILE
      )
    }
  };
}

export function updateRuntimeConfig(input: Partial<AdminRuntimeConfig>) {
  const envMap = readRuntimeEnvMap();
  const next: Record<string, string> = {
    ...envMap,
    LOBSTER_BOOTSTRAPPED: envMap.LOBSTER_BOOTSTRAPPED || "1",
    LOBSTER_ENV_VERSION: envMap.LOBSTER_ENV_VERSION || "1",
    LOBSTER_ADMIN_PORT: String(input.adminPort ?? parsePositiveInteger(envMap.LOBSTER_ADMIN_PORT, 4545)),
    LOBSTER_BRIDGE_BIN: input.bridgeBin ?? envMap.LOBSTER_BRIDGE_BIN ?? "",
    LOBSTER_DATA_PATH: input.dataPath ?? envMap.LOBSTER_DATA_PATH ?? "/tmp/lobster/lobster.sqlite",
    LOBSTER_SOCKET_PATH: input.socketPath ?? envMap.LOBSTER_SOCKET_PATH ?? "/tmp/lobster/lobsterd.sock",
    LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS: (input.telegramAllowedChatIds ?? splitCsv(envMap.LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS)).join(","),
    LOBSTER_TELEGRAM_BASE_URL: input.telegramBaseUrl ?? envMap.LOBSTER_TELEGRAM_BASE_URL ?? "https://api.telegram.org",
    LOBSTER_TELEGRAM_POLL_INTERVAL_MS: String(
      input.telegramPollIntervalMs ?? parsePositiveInteger(envMap.LOBSTER_TELEGRAM_POLL_INTERVAL_MS, 1500)
    ),
    LOBSTER_TELEGRAM_TEXT_MODE: normalizeTextMode(input.telegramTextMode ?? envMap.LOBSTER_TELEGRAM_TEXT_MODE)
  };

  if (!next.LOBSTER_TELEGRAM_BOT_TOKEN_FILE) {
    next.LOBSTER_TELEGRAM_BOT_TOKEN_FILE = relative(CONFIG_DIR, TELEGRAM_TOKEN_FILE);
  }
  if (!next.OPENAI_COMPATIBLE_API_KEY_FILE) {
    next.OPENAI_COMPATIBLE_API_KEY_FILE = relative(CONFIG_DIR, OPENAI_COMPATIBLE_API_KEY_FILE);
  }

  writeRuntimeEnvMap(next);
  applyEnvMapToProcess(next);
  return readAdminConfigSnapshot();
}

export function updateModelConfig(raw: unknown) {
  const yaml =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "raw" in raw && typeof raw.raw === "string"
        ? raw.raw
        : YAML.stringify(raw);
  mkdirSync(dirname(MODELS_PATH), { recursive: true });
  writeFileSync(MODELS_PATH, yaml, "utf8");
  return readAdminConfigSnapshot();
}

export function updateSecrets(input: { openaiCompatibleApiKey?: string; telegramBotToken?: string }) {
  mkdirSync(SECRETS_DIR, { recursive: true });
  if (typeof input.telegramBotToken === "string") {
    writeFileSync(TELEGRAM_TOKEN_FILE, `${input.telegramBotToken.trim()}\n`, "utf8");
    process.env.LOBSTER_TELEGRAM_BOT_TOKEN = input.telegramBotToken.trim();
    process.env.LOBSTER_TELEGRAM_BOT_TOKEN_FILE = relative(CONFIG_DIR, TELEGRAM_TOKEN_FILE);
  }
  if (typeof input.openaiCompatibleApiKey === "string") {
    writeFileSync(OPENAI_COMPATIBLE_API_KEY_FILE, `${input.openaiCompatibleApiKey.trim()}\n`, "utf8");
    process.env.OPENAI_COMPATIBLE_API_KEY = input.openaiCompatibleApiKey.trim();
    process.env.OPENAI_COMPATIBLE_API_KEY_FILE = relative(CONFIG_DIR, OPENAI_COMPATIBLE_API_KEY_FILE);
  }

  const envMap = readRuntimeEnvMap();
  envMap.LOBSTER_TELEGRAM_BOT_TOKEN_FILE = process.env.LOBSTER_TELEGRAM_BOT_TOKEN_FILE ?? relative(CONFIG_DIR, TELEGRAM_TOKEN_FILE);
  envMap.OPENAI_COMPATIBLE_API_KEY_FILE =
    process.env.OPENAI_COMPATIBLE_API_KEY_FILE ?? relative(CONFIG_DIR, OPENAI_COMPATIBLE_API_KEY_FILE);
  writeRuntimeEnvMap(envMap);
  return readAdminConfigSnapshot();
}

function readRuntimeEnvMap() {
  if (!existsSync(RUNTIME_ENV_PATH)) {
    return {} as Record<string, string>;
  }

  return Object.fromEntries(parseEnvFile(readFileSync(RUNTIME_ENV_PATH, "utf8")).map((entry) => [entry.key, entry.value]));
}

function writeRuntimeEnvMap(values: Record<string, string>) {
  mkdirSync(dirname(RUNTIME_ENV_PATH), { recursive: true });
  const preferredKeys = [
    "LOBSTER_BOOTSTRAPPED",
    "LOBSTER_ENV_VERSION",
    "LOBSTER_ADMIN_PORT",
    "LOBSTER_SOCKET_PATH",
    "LOBSTER_DATA_PATH",
    "LOBSTER_BRIDGE_BIN",
    "LOBSTER_TELEGRAM_BOT_TOKEN_FILE",
    "LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS",
    "LOBSTER_TELEGRAM_BASE_URL",
    "LOBSTER_TELEGRAM_POLL_INTERVAL_MS",
    "LOBSTER_TELEGRAM_TEXT_MODE",
    "OPENAI_COMPATIBLE_API_KEY_FILE",
    "NODE_EXTRA_CA_CERTS"
  ];

  const remaining = Object.keys(values)
    .filter((key) => !preferredKeys.includes(key))
    .sort((left, right) => left.localeCompare(right));
  const orderedKeys = [...preferredKeys.filter((key) => key in values), ...remaining];
  const lines = [
    "# Lobster runtime environment",
    `# generated_at=${new Date().toISOString()}`,
    ...orderedKeys.map((key) => `${key}=${serializeEnvValue(values[key] ?? "")}`)
  ];
  writeFileSync(RUNTIME_ENV_PATH, `${lines.join("\n")}\n`, "utf8");
}

function applyEnvMapToProcess(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTextMode(value: string | undefined) {
  return value === "chat" || value === "hybrid" ? value : "task";
}

function resolveSecretConfigured(inlineValue: string | undefined, fileValue: string | undefined, defaultPath: string) {
  if (inlineValue?.trim()) {
    return true;
  }

  const targetPath = fileValue?.trim() ? resolve(CONFIG_DIR, fileValue) : defaultPath;
  return existsSync(targetPath) && readFileSync(targetPath, "utf8").trim().length > 0;
}

function serializeEnvValue(value: string) {
  if (!value) {
    return "";
  }

  if (/^[A-Za-z0-9_./,:-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import YAML from "yaml";
import { resolveWorkspaceConfigFile } from "../modules/paths.js";
import { parseEnvFile, resolveRuntimeEnvPath } from "../modules/runtimeEnv.js";

type ModelRole = "planner" | "vision" | "executor" | "critic";

type ModelsConfig = {
  defaultProvider: "openai-compatible";
  profiles: Record<
    ModelRole,
    {
      provider: "openai-compatible";
      modelId: string;
      baseURL: string;
      apiKeyRef: string;
      timeoutMs: number;
      budget: {
        inputTokens: number;
        outputTokens: number;
      };
      fallback: string[];
    }
  >;
};

type BootstrapStatus = {
  envPath: string;
  isReady: boolean;
  missing: string[];
  modelsPath: string;
};

const ROLE_ORDER: ModelRole[] = ["planner", "vision", "executor", "critic"];
const DEFAULT_ROLE_MODELS: Record<ModelRole, string> = {
  planner: "gpt-4.1",
  vision: "gpt-4.1",
  executor: "gpt-4.1-mini",
  critic: "gpt-4.1-mini"
};
const DEFAULT_ROLE_TIMEOUTS: Record<ModelRole, number> = {
  planner: 30000,
  vision: 30000,
  executor: 20000,
  critic: 20000
};
const DEFAULT_ROLE_BUDGETS: Record<ModelRole, { inputTokens: number; outputTokens: number }> = {
  planner: { inputTokens: 16000, outputTokens: 3000 },
  vision: { inputTokens: 12000, outputTokens: 2000 },
  executor: { inputTokens: 8000, outputTokens: 1500 },
  critic: { inputTokens: 8000, outputTokens: 1500 }
};

const MODELS_PATH = resolveWorkspaceConfigFile({
  importMetaUrl: import.meta.url,
  name: "models.yaml",
  override: process.env.LOBSTER_MODELS_PATH
});
const RUNTIME_ENV_PATH = resolveRuntimeEnvPath();

export function getBootstrapStatus(): BootstrapStatus {
  const missing: string[] = [];
  if (!existsSync(RUNTIME_ENV_PATH)) {
    missing.push(`missing ${RUNTIME_ENV_PATH}`);
  }
  if (!existsSync(MODELS_PATH)) {
    missing.push(`missing ${MODELS_PATH}`);
  }

  if (existsSync(RUNTIME_ENV_PATH)) {
    const raw = readFileSync(RUNTIME_ENV_PATH, "utf8");
    const entries = parseEnvFile(raw);
    const marker = entries.find((entry) => entry.key === "LOBSTER_BOOTSTRAPPED")?.value;
    if (marker !== "1") {
      missing.push("LOBSTER_BOOTSTRAPPED marker not found in runtime.env");
    }
  }

  return {
    envPath: RUNTIME_ENV_PATH,
    modelsPath: MODELS_PATH,
    isReady: missing.length === 0,
    missing
  };
}

export async function runBootstrapWizard() {
  const runtimeEnvDefaults = readEnvMapIfPresent(RUNTIME_ENV_PATH);
  const existingApiRefs = readModelApiRefsIfPresent(MODELS_PATH);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("Lobster Bootstrap Wizard");
    console.log(`Models config: ${MODELS_PATH}`);
    console.log(`Runtime env: ${RUNTIME_ENV_PATH}`);
    console.log("");

    const telegramEnabled = await askYesNo(
      rl,
      "启用 Telegram 私聊入口？",
      Boolean(runtimeEnvDefaults.LOBSTER_TELEGRAM_BOT_TOKEN)
    );
    let telegramToken = runtimeEnvDefaults.LOBSTER_TELEGRAM_BOT_TOKEN ?? "";
    let telegramBaseUrl = runtimeEnvDefaults.LOBSTER_TELEGRAM_BASE_URL ?? "https://api.telegram.org";
    let telegramAllowedChatIds = runtimeEnvDefaults.LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS ?? "";
    let telegramProxyUrl = "";
    let nodeExtraCaCerts = runtimeEnvDefaults.NODE_EXTRA_CA_CERTS ?? "";
    if (telegramEnabled) {
      telegramToken = await askText(rl, "Telegram Bot Token", telegramToken);
      telegramBaseUrl = await askText(rl, "Telegram Base URL", telegramBaseUrl);
      const enableTelegramProxy = await askYesNo(
        rl,
        "是否启用 Telegram 代理？",
        Boolean(runtimeEnvDefaults.LOBSTER_TELEGRAM_PROXY_URL)
      );
      if (enableTelegramProxy) {
        telegramProxyUrl = await askText(
          rl,
          "Telegram 代理 URL",
          runtimeEnvDefaults.LOBSTER_TELEGRAM_PROXY_URL ?? "http://127.0.0.1:7897"
        );
      }
      const enableCustomCaBundle = await askYesNo(
        rl,
        "是否配置自定义 TLS CA 证书（推荐，解决代理证书校验）？",
        Boolean(nodeExtraCaCerts)
      );
      if (enableCustomCaBundle) {
        nodeExtraCaCerts = await askText(
          rl,
          "NODE_EXTRA_CA_CERTS（相对 runtime.env 的路径或绝对路径）",
          nodeExtraCaCerts || "certs/globalsign-chain.pem"
        );
      } else {
        nodeExtraCaCerts = "";
      }
      if (runtimeEnvDefaults.LOBSTER_TELEGRAM_TEXT_MODE === undefined) {
        console.log("提示：LOBSTER_TELEGRAM_TEXT_MODE 可选，支持 task/chat/hybrid，默认是 hybrid。");
      }
      telegramAllowedChatIds = await askText(
        rl,
        "Telegram 允许的 chat_id（可留空，多个用逗号）",
        telegramAllowedChatIds
      );
    } else {
      telegramToken = "";
      telegramAllowedChatIds = "";
      nodeExtraCaCerts = "";
    }

    console.log("");
    console.log("模型接入模式：");
    console.log("1) OpenAI-compatible（推荐，统一 baseURL + modelId）");
    console.log("2) 保留当前 models.yaml，不改模型配置");
    const mode = await askChoice(rl, "请选择模式", 1, 2);

    let generatedModelsConfig: ModelsConfig | undefined;
    let apiKeyRefs: string[] = [];

    if (mode === 1) {
      const defaultBaseUrl = runtimeEnvDefaults.LOBSTER_OPENAI_COMPAT_BASE_URL ?? "https://api.openai.com/v1";
      const defaultApiKeyRef = existingApiRefs[0] ?? "OPENAI_COMPATIBLE_API_KEY";
      const baseUrl = await askText(rl, "OpenAI-compatible baseURL", defaultBaseUrl);
      const apiKeyRefInput = await askText(rl, "API Key 环境变量名", defaultApiKeyRef);
      const normalizedApiKeyRef = normalizeApiKeyRef(
        apiKeyRefInput,
        defaultApiKeyRefForProvider("openai-compatible")
      );
      const apiKeyRef = normalizedApiKeyRef.ref;
      if (normalizedApiKeyRef.corrected) {
        if (normalizedApiKeyRef.fromRawKey) {
          console.log(
            `检测到你输入的是原始 key，已自动改为环境变量名 ${apiKeyRef}，并将 key 作为该变量的值写入 runtime.env。`
          );
        } else {
          console.log(`检测到非法环境变量名，已自动改为 ${apiKeyRef}。`);
        }
      }
      const singleModel = await askYesNo(rl, "四个角色使用同一个 modelId？", false);

      const roleModels: Record<ModelRole, string> = {
        planner: "",
        vision: "",
        executor: "",
        critic: ""
      };
      if (singleModel) {
        const unifiedModel = await askText(
          rl,
          "统一 modelId",
          runtimeEnvDefaults.LOBSTER_OPENAI_COMPAT_MODEL ?? "gpt-4.1-mini"
        );
        for (const role of ROLE_ORDER) {
          roleModels[role] = unifiedModel;
        }
      } else {
        for (const role of ROLE_ORDER) {
          roleModels[role] = await askText(
            rl,
            `${role} modelId`,
            DEFAULT_ROLE_MODELS[role]
          );
        }
      }

      generatedModelsConfig = {
        defaultProvider: "openai-compatible",
        profiles: {
          planner: toOpenAICompatibleProfile("planner", roleModels.planner, baseUrl, apiKeyRef),
          vision: toOpenAICompatibleProfile("vision", roleModels.vision, baseUrl, apiKeyRef),
          executor: toOpenAICompatibleProfile("executor", roleModels.executor, baseUrl, apiKeyRef),
          critic: toOpenAICompatibleProfile("critic", roleModels.critic, baseUrl, apiKeyRef)
        }
      };
      apiKeyRefs = [apiKeyRef];
      if (normalizedApiKeyRef.fromRawKey && normalizedApiKeyRef.rawKeyValue) {
        runtimeEnvDefaults[apiKeyRef] = normalizedApiKeyRef.rawKeyValue;
      }
    } else {
      apiKeyRefs = existingApiRefs.length > 0 ? existingApiRefs : ["OPENAI_COMPATIBLE_API_KEY"];
    }

    const keyValues = new Map<string, string>();
    for (const keyRef of apiKeyRefs) {
      const existing = runtimeEnvDefaults[keyRef] ?? "";
      const value = await askText(rl, `${keyRef}（可留空，后续手动 export）`, existing);
      keyValues.set(keyRef, value);
    }

    const bridgeBin = await askText(
      rl,
      "LOBSTER_BRIDGE_BIN（可留空，后续再填）",
      runtimeEnvDefaults.LOBSTER_BRIDGE_BIN ?? ""
    );
    const socketPath = await askText(
      rl,
      "LOBSTER_SOCKET_PATH",
      runtimeEnvDefaults.LOBSTER_SOCKET_PATH ?? "/tmp/lobster/lobsterd.sock"
    );
    const dataPath = await askText(
      rl,
      "LOBSTER_DATA_PATH",
      runtimeEnvDefaults.LOBSTER_DATA_PATH ?? "/tmp/lobster/lobster.sqlite"
    );

    console.log("");
    const proceed = await askYesNo(rl, "确认写入配置文件？", true);
    if (!proceed) {
      console.log("已取消，未写入任何文件。");
      return;
    }

    const runtimeEnvContent = buildRuntimeEnvContent({
      bridgeBin,
      dataPath,
      keyValues,
      socketPath,
      telegramAllowedChatIds,
      telegramBaseUrl,
      nodeExtraCaCerts,
      telegramProxyUrl,
      telegramToken
    });
    const runtimeBackup = writeWithBackup(RUNTIME_ENV_PATH, runtimeEnvContent);

    let modelsBackup: string | undefined;
    if (generatedModelsConfig) {
      const yaml = YAML.stringify(generatedModelsConfig);
      modelsBackup = writeWithBackup(MODELS_PATH, yaml);
    }

    console.log("");
    console.log("Bootstrap completed.");
    console.log(`- runtime env: ${RUNTIME_ENV_PATH}${runtimeBackup ? ` (backup: ${runtimeBackup})` : ""}`);
    if (generatedModelsConfig) {
      console.log(`- models: ${MODELS_PATH}${modelsBackup ? ` (backup: ${modelsBackup})` : ""}`);
    } else {
      console.log("- models: kept existing models.yaml");
    }
    console.log("");
    console.log("Next:");
    console.log("1) pnpm --filter lobsterd run doctor");
    console.log("2) pnpm --filter lobsterd run start");
    console.log("3) (optional) pnpm dev:app");
  } finally {
    rl.close();
  }
}

function toOpenAICompatibleProfile(
  role: ModelRole,
  modelId: string,
  baseURL: string,
  apiKeyRef: string
) {
  return {
    provider: "openai-compatible" as const,
    modelId,
    baseURL,
    apiKeyRef,
    timeoutMs: DEFAULT_ROLE_TIMEOUTS[role],
    budget: DEFAULT_ROLE_BUDGETS[role],
    fallback: []
  };
}

export function buildRuntimeEnvContent(params: {
  bridgeBin: string;
  dataPath: string;
  keyValues: Map<string, string>;
  socketPath: string;
  telegramAllowedChatIds: string;
  telegramBaseUrl: string;
  nodeExtraCaCerts: string;
  telegramProxyUrl: string;
  telegramToken: string;
}) {
  const {
    bridgeBin,
    dataPath,
    keyValues,
    socketPath,
    telegramAllowedChatIds,
    telegramBaseUrl,
    nodeExtraCaCerts,
    telegramProxyUrl,
    telegramToken
  } = params;
  const lines = [
    "# Lobster runtime environment (generated by bootstrap)",
    `# generated_at=${new Date().toISOString()}`,
    "LOBSTER_BOOTSTRAPPED=1",
    "LOBSTER_ENV_VERSION=1",
    `LOBSTER_SOCKET_PATH=${serializeEnvValue(socketPath)}`,
    `LOBSTER_DATA_PATH=${serializeEnvValue(dataPath)}`,
    `LOBSTER_BRIDGE_BIN=${serializeEnvValue(bridgeBin)}`,
    `LOBSTER_TELEGRAM_BOT_TOKEN=${serializeEnvValue(telegramToken)}`,
    `LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS=${serializeEnvValue(telegramAllowedChatIds)}`,
    `LOBSTER_TELEGRAM_BASE_URL=${serializeEnvValue(telegramBaseUrl)}`
  ];
  if (telegramProxyUrl.trim()) {
    lines.push(`LOBSTER_TELEGRAM_PROXY_URL=${serializeEnvValue(telegramProxyUrl)}`);
  }
  if (nodeExtraCaCerts.trim()) {
    lines.push(`NODE_EXTRA_CA_CERTS=${serializeEnvValue(nodeExtraCaCerts)}`);
  }

  for (const [key, value] of keyValues.entries()) {
    lines.push(`${key}=${serializeEnvValue(value)}`);
  }

  return `${lines.join("\n")}\n`;
}

function serializeEnvValue(value: string) {
  if (!value) {
    return "";
  }

  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeWithBackup(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const exists = existsSync(path);
  if (exists) {
    const current = readFileSync(path, "utf8");
    if (current === content) {
      return undefined;
    }

    const backup = `${path}.bak.${Date.now()}`;
    copyFileSync(path, backup);
    writeFileSync(path, content, "utf8");
    return backup;
  }

  writeFileSync(path, content, "utf8");
  return undefined;
}

function readEnvMapIfPresent(path: string) {
  if (!existsSync(path)) {
    return {} as Record<string, string>;
  }

  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  return Object.fromEntries(parsed.map((entry) => [entry.key, entry.value]));
}

function readModelApiRefsIfPresent(path: string) {
  if (!existsSync(path)) {
    return [] as string[];
  }

  try {
    const raw = YAML.parse(readFileSync(path, "utf8")) as
      | {
          profiles?: Record<
            string,
            { apiKeyRef?: string; provider?: "openai" | "anthropic" | "google" | "openai-compatible" }
          >;
        }
      | undefined;
    const values = Object.values(raw?.profiles ?? {}).map((profile) => {
      const fallback = defaultApiKeyRefForProvider(profile.provider);
      const normalized = normalizeApiKeyRef(profile.apiKeyRef?.trim() ?? "", fallback);
      return normalized.ref;
    });
    return Array.from(new Set(values));
  } catch {
    return [] as string[];
  }
}

function defaultApiKeyRefForProvider(provider?: "openai" | "anthropic" | "google" | "openai-compatible") {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    case "openai-compatible":
    default:
      return "OPENAI_COMPATIBLE_API_KEY";
  }
}

function normalizeApiKeyRef(value: string, fallbackRef: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return { corrected: true, fromRawKey: false, ref: fallbackRef } as const;
  }

  if (isValidEnvVarName(trimmed)) {
    return { corrected: false, fromRawKey: false, ref: trimmed } as const;
  }

  if (looksLikeRawApiKey(trimmed)) {
    return { corrected: true, fromRawKey: true, rawKeyValue: trimmed, ref: fallbackRef } as const;
  }

  return { corrected: true, fromRawKey: false, ref: fallbackRef } as const;
}

function isValidEnvVarName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function looksLikeRawApiKey(value: string) {
  return /^sk-[A-Za-z0-9_-]{12,}$/.test(value);
}

async function askChoice(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: number,
  maxChoice: number
) {
  while (true) {
    const answer = (await rl.question(`${question} [${defaultValue}]: `)).trim();
    if (!answer) {
      return defaultValue;
    }

    const parsed = Number.parseInt(answer, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= maxChoice) {
      return parsed;
    }

    console.log(`请输入 1-${maxChoice}。`);
  }
}

async function askText(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: string
) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes: boolean
) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultYes;
    }

    if (["y", "yes", "是", "1"].includes(answer)) {
      return true;
    }
    if (["n", "no", "否", "0"].includes(answer)) {
      return false;
    }

    console.log("请输入 y 或 n。");
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runBootstrapWizard().catch((error) => {
    if (isAbortError(error)) {
      console.log("Bootstrap cancelled.");
      process.exitCode = 130;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ABORT_ERR";
}

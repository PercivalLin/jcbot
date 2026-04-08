import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelProfile } from "@lobster/shared";
import type { BridgeCapabilities } from "./bridgeClient.js";
import type { ChatPluginInstance } from "./chatPluginRegistry.js";
import { validateTelegramBaseUrl } from "./telegramDiagnostics.js";
import type { TelegramRuntimeConfig } from "./telegramConfig.js";

export type RuntimeReadinessLevel = "ok" | "warn" | "fail";

export type RuntimeReadinessCheck = {
  id: string;
  level: RuntimeReadinessLevel;
  message: string;
  suggestion?: string;
};

export type RuntimeReadinessReport = {
  checks: RuntimeReadinessCheck[];
  generatedAt: string;
  summary: {
    fail: number;
    ok: number;
    warn: number;
  };
};

type RuntimeReadinessInput = {
  bridgeBinaryPath?: string;
  bridgeCapabilities?: BridgeCapabilities;
  chatPlugins: ChatPluginInstance[];
  dataPath: string;
  telegram?: TelegramRuntimeConfig;
  profiles: Record<ModelProfile["role"], ModelProfile>;
  socketPath: string;
};

export function buildRuntimeReadinessReport(input: RuntimeReadinessInput): RuntimeReadinessReport {
  const checks: RuntimeReadinessCheck[] = [];

  checks.push(checkWritablePath("runtime.socketPath", dirname(input.socketPath), "Socket directory"));
  checks.push(checkWritablePath("runtime.dataPath", dirname(input.dataPath), "Data directory"));
  checks.push(checkBridgeMode(input.bridgeBinaryPath));
  checks.push(...checkModelCredentials(input.profiles));
  checks.push({
    id: "chat.ingress.local",
    level: "ok",
    message: "Local standalone chat ingress is enabled (desktop console + local chat REPL)."
  });
  if (input.telegram) {
    checks.push(...checkTelegramConfig(input.telegram));
  }
  checks.push(checkChatPlugins(input.chatPlugins));

  if (input.bridgeCapabilities) {
    checks.push(...checkBridgeCapabilities(input.bridgeCapabilities));
  } else {
    checks.push({
      id: "bridge.capabilities.unavailable",
      level: "warn",
      message: "Bridge capability probe not available in this context.",
      suggestion: "Run lobsterd and open Runtime Readiness in desktop console."
    });
  }

  const summary = checks.reduce(
    (accumulator, check) => {
      accumulator[check.level] += 1;
      return accumulator;
    },
    { fail: 0, ok: 0, warn: 0 }
  );

  return {
    checks,
    summary,
    generatedAt: new Date().toISOString()
  };
}

function checkWritablePath(id: string, targetPath: string, label: string): RuntimeReadinessCheck {
  try {
    accessSync(targetPath, constants.W_OK);
    return {
      id,
      level: "ok",
      message: `${label} is writable: ${targetPath}`
    };
  } catch {
    return {
      id,
      level: "fail",
      message: `${label} is not writable: ${targetPath}`,
      suggestion: "Create the directory and ensure current user has write permission."
    };
  }
}

function checkBridgeMode(bridgeBinaryPath?: string): RuntimeReadinessCheck {
  if (!bridgeBinaryPath) {
    return {
      id: "bridge.mode",
      level: "warn",
      message: "Bridge is running in stub mode (LOBSTER_BRIDGE_BIN not set).",
      suggestion: "Set LOBSTER_BRIDGE_BIN to compiled lobster-bridge for real computer-use actions."
    };
  }

  if (!existsSync(bridgeBinaryPath)) {
    return {
      id: "bridge.mode",
      level: "fail",
      message: `Configured bridge binary does not exist: ${bridgeBinaryPath}`,
      suggestion: "Build native/lobster-bridge and update LOBSTER_BRIDGE_BIN."
    };
  }

  return {
    id: "bridge.mode",
    level: "ok",
    message: `Native bridge binary found: ${bridgeBinaryPath}`
  };
}

function checkModelCredentials(profiles: Record<ModelProfile["role"], ModelProfile>): RuntimeReadinessCheck[] {
  return (Object.keys(profiles) as ModelProfile["role"][]).map((role) => {
    const profile = profiles[role];
    const credential = resolveCredentialStatus(profile);
    return credential.ready
      ? {
          id: `models.${role}`,
          level: "ok",
          message: `${role} model is ready (${profile.provider}/${profile.modelId}; credential=${credential.source}).`
        }
      : {
          id: `models.${role}`,
          level: "warn",
          message: `${role} model will fallback to stub (${profile.provider}/${profile.modelId}).`,
          suggestion: credential.suggestion
        };
  });
}

function resolveCredentialStatus(profile: ModelProfile): {
  ready: boolean;
  source: string;
  suggestion?: string;
} {
  const explicitRef = profile.apiKeyRef?.trim();
  if (explicitRef) {
    if (!isValidEnvVarName(explicitRef)) {
      const recommendedRef = defaultCredentialRefs(profile.provider)[0] ?? "OPENAI_API_KEY";
      return {
        ready: false,
        source: "invalid-apiKeyRef",
        suggestion:
          `models.yaml apiKeyRef must be an environment variable name, not a raw key. ` +
          `Use apiKeyRef=${recommendedRef}, then export ${recommendedRef}=<your key>.`
      };
    }

    const value = process.env[explicitRef]?.trim();
    if (value) {
      return { ready: true, source: explicitRef };
    }

    return {
      ready: false,
      source: explicitRef,
      suggestion: `Export ${explicitRef}=<your key> before starting lobsterd.`
    };
  }

  if (profile.provider === "openai-compatible" && isLocalBaseUrl(profile.baseURL)) {
    return {
      ready: true,
      source: "local-baseURL-no-key"
    };
  }

  const defaultRefs = defaultCredentialRefs(profile.provider);
  for (const ref of defaultRefs) {
    const value = process.env[ref]?.trim();
    if (value) {
      return { ready: true, source: ref };
    }
  }

  return {
    ready: false,
    source: defaultRefs.join("|") || "none",
    suggestion: defaultRefs.length > 0
      ? `Export ${defaultRefs[0]}=<your key>, or configure apiKeyRef in models.yaml.`
      : "Configure a valid provider credential."
  };
}

function defaultCredentialRefs(provider: ModelProfile["provider"]) {
  switch (provider) {
    case "openai":
      return ["OPENAI_API_KEY"];
    case "anthropic":
      return ["ANTHROPIC_API_KEY"];
    case "google":
      return ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"];
    case "openai-compatible":
      return ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"];
  }
}

function isValidEnvVarName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function checkTelegramConfig(config: TelegramRuntimeConfig): RuntimeReadinessCheck[] {
  const checks: RuntimeReadinessCheck[] = [];
  const baseUrlIssue = validateTelegramBaseUrl(config.baseUrl);
  checks.push(
    baseUrlIssue
      ? {
          id: "telegram.baseUrl",
          level: "warn",
          message: `Telegram base URL may be invalid: ${config.baseUrl}`,
          suggestion: `${baseUrlIssue} Keep only host prefix, for example https://api.telegram.org.`
        }
      : {
          id: "telegram.baseUrl",
          level: "ok",
          message: `Telegram base URL is configured: ${config.baseUrl}`
        }
  );

  if (config.botToken) {
    checks.push({
      id: "telegram.ingress",
      level: "ok",
      message: "Telegram polling ingress is enabled."
    });
  } else {
    checks.push({
      id: "telegram.ingress",
      level: "warn",
      message: "Telegram ingress is disabled (LOBSTER_TELEGRAM_BOT_TOKEN not set).",
      suggestion: "Set LOBSTER_TELEGRAM_BOT_TOKEN to enable Telegram chat ingress."
    });
  }

  checks.push(
    {
      id: "telegram.textMode",
      level: "ok",
      message: `Telegram text mode: ${config.textMode}`
    }
  );

  checks.push(
    config.allowedChatIds && config.allowedChatIds.length > 0
      ? {
          id: "telegram.allowlist",
          level: "ok",
          message: `Telegram chat allowlist enabled (${config.allowedChatIds.length} chat id(s)).`
        }
      : {
          id: "telegram.allowlist",
          level: "ok",
          message: "Telegram chat allowlist not set (all chats are accepted by default).",
          suggestion:
            "Set LOBSTER_TELEGRAM_ALLOWED_CHAT_IDS to restrict who can trigger actions (tip: run `pnpm --filter lobsterd run telegram:whoami`)."
        }
  );

  return checks;
}
function checkChatPlugins(plugins: ChatPluginInstance[]): RuntimeReadinessCheck {
  const enabled = plugins.filter((plugin) => plugin.enabled);
  if (enabled.length === 0) {
    return {
      id: "chat.plugins",
      level: "warn",
      message: "No chat plugin instance enabled.",
      suggestion: "Enable at least one entry in config/chat_plugins.yaml."
    };
  }

  return {
    id: "chat.plugins",
    level: "ok",
    message: `Enabled chat plugins: ${enabled.map((plugin) => plugin.appName).join(", ")}`
  };
}

function checkBridgeCapabilities(capabilities: BridgeCapabilities): RuntimeReadinessCheck[] {
  const checks: RuntimeReadinessCheck[] = [];

  checks.push(
    capabilities.policyHardGate
      ? {
          id: "bridge.policyHardGate",
          level: "ok",
          message: "Bridge hard-gate is enabled."
        }
      : {
          id: "bridge.policyHardGate",
          level: "fail",
          message: "Bridge hard-gate is disabled.",
          suggestion: "Do not run with this bridge build; hard-gate must stay enabled."
        }
  );

  checks.push(
    capabilities.accessibility
      ? {
          id: "bridge.accessibility",
          level: "ok",
          message: "macOS Accessibility permission is granted."
        }
      : {
          id: "bridge.accessibility",
          level: "warn",
          message: "macOS Accessibility permission is missing.",
          suggestion: "Grant Accessibility permission in System Settings -> Privacy & Security."
        }
  );

  checks.push(
    capabilities.screenCapture
      ? {
          id: "bridge.screenCapture",
          level: "ok",
          message: "macOS Screen Recording permission is granted."
        }
      : {
          id: "bridge.screenCapture",
          level: "warn",
          message: "macOS Screen Recording permission is missing.",
          suggestion: "Grant Screen Recording permission in System Settings -> Privacy & Security."
        }
  );

  checks.push(
    capabilities.eventTap
      ? {
          id: "bridge.eventTap",
          level: "ok",
          message: "Input event tap capability is available."
        }
      : {
          id: "bridge.eventTap",
          level: "warn",
          message: "Input event tap capability is unavailable.",
          suggestion: "Verify bridge binary entitlements and macOS input monitoring permissions."
        }
  );

  checks.push(
    capabilities.ocr
      ? {
          id: "bridge.ocr",
          level: "ok",
          message: "OCR capability is available."
        }
      : {
          id: "bridge.ocr",
          level: "warn",
          message: "OCR capability is unavailable in current bridge build."
        }
  );

  return checks;
}

function isLocalBaseUrl(baseURL?: string) {
  if (!baseURL) {
    return false;
  }

  try {
    const parsed = new URL(baseURL);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

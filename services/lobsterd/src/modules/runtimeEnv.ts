import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveWorkspaceConfigFile } from "./paths.js";

const MODELS_PATH = resolveWorkspaceConfigFile({
  importMetaUrl: import.meta.url,
  name: "models.yaml",
  override: process.env.LOBSTER_MODELS_PATH
});
const RUNTIME_ENV_PATH = process.env.LOBSTER_ENV_PATH?.trim() || join(dirname(MODELS_PATH), "runtime.env");

export type RuntimeEnvEntry = {
  key: string;
  value: string;
};

const RELATIVE_PATH_KEYS = new Set(["NODE_EXTRA_CA_CERTS"]);

export function resolveRuntimeEnvPath() {
  return RUNTIME_ENV_PATH;
}

export function parseEnvFile(raw: string): RuntimeEnvEntry[] {
  const entries: RuntimeEnvEntry[] = [];
  const lines = raw.split(/\r?\n/g);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = parseEnvValue(rawValue);
    entries.push({ key, value });
  }

  return entries;
}

export function loadRuntimeEnvFile(path = RUNTIME_ENV_PATH) {
  if (!existsSync(path)) {
    return {
      path,
      loaded: [] as RuntimeEnvEntry[]
    };
  }

  const raw = readFileSync(path, "utf8");
  const parsed = parseEnvFile(raw);
  const loaded: RuntimeEnvEntry[] = [];

  // Backward compatibility: old bootstrap versions could accidentally write
  // a raw `sk-...` key as env-variable name (with empty value).
  maybeRecoverMiswiredOpenAICompatibleKey(parsed, loaded);

  for (const entry of parsed) {
    if (!isValidEnvVarName(entry.key)) {
      continue;
    }
    if (process.env[entry.key] !== undefined) {
      continue;
    }

    const normalizedValue = normalizeRuntimeEnvValue(entry.key, entry.value, path);
    process.env[entry.key] = normalizedValue;
    loaded.push({ key: entry.key, value: normalizedValue });
  }

  loadFileBackedEnvEntries(parsed, loaded, path);

  return {
    path,
    loaded
  };
}

function maybeRecoverMiswiredOpenAICompatibleKey(parsed: RuntimeEnvEntry[], loaded: RuntimeEnvEntry[]) {
  if (process.env.OPENAI_COMPATIBLE_API_KEY !== undefined || process.env.OPENAI_API_KEY !== undefined) {
    return;
  }

  const explicitCompat = parsed.find((entry) => entry.key === "OPENAI_COMPATIBLE_API_KEY" && entry.value.trim());
  if (explicitCompat) {
    return;
  }

  const miswired = parsed.find((entry) => looksLikeRawApiKey(entry.key) && entry.value === "");
  if (!miswired) {
    return;
  }

  process.env.OPENAI_COMPATIBLE_API_KEY = miswired.key;
  loaded.push({ key: "OPENAI_COMPATIBLE_API_KEY", value: miswired.key });
}

function isValidEnvVarName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function looksLikeRawApiKey(value: string) {
  return /^sk-[A-Za-z0-9_-]{12,}$/.test(value);
}

function parseEnvValue(raw: string) {
  if (!raw) {
    return "";
  }

  const singleQuoted = raw.match(/^'(.*)'$/);
  if (singleQuoted) {
    return singleQuoted[1] ?? "";
  }

  const doubleQuoted = raw.match(/^"(.*)"$/);
  if (doubleQuoted) {
    return (
      doubleQuoted[1]
        ?.replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\") ?? ""
    );
  }

  return raw;
}

function loadFileBackedEnvEntries(parsed: RuntimeEnvEntry[], loaded: RuntimeEnvEntry[], envFilePath: string) {
  const baseDir = dirname(envFilePath);
  for (const entry of parsed) {
    if (!entry.key.endsWith("_FILE")) {
      continue;
    }

    const targetKey = entry.key.slice(0, -"_FILE".length);
    if (!isValidEnvVarName(targetKey)) {
      continue;
    }

    const hasExplicitValue = process.env[targetKey] !== undefined && process.env[targetKey] !== "";
    if (hasExplicitValue) {
      continue;
    }

    const fileRef = entry.value.trim();
    if (!fileRef) {
      continue;
    }

    const filePath = resolve(baseDir, fileRef);
    if (!existsSync(filePath)) {
      continue;
    }

    const fileValue = readFileSync(filePath, "utf8").trim();
    if (!fileValue) {
      continue;
    }

    const normalizedValue = normalizeRuntimeEnvValue(targetKey, fileValue, envFilePath);
    process.env[targetKey] = normalizedValue;
    loaded.push({
      key: targetKey,
      value: normalizedValue
    });
  }
}

function normalizeRuntimeEnvValue(key: string, value: string, envFilePath: string) {
  if (!RELATIVE_PATH_KEYS.has(key)) {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || isAbsolute(trimmed)) {
    return trimmed;
  }

  return resolve(dirname(envFilePath), trimmed);
}

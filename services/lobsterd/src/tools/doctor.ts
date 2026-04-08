import { loadModelProfiles } from "../modules/config.js";
import { getEnabledChatPluginApplications, loadChatPluginRegistry } from "../modules/chatPluginRegistry.js";
import { resolveWorkspaceConfigFile } from "../modules/paths.js";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";
import { buildRuntimeReadinessReport, type RuntimeReadinessCheck } from "../modules/runtimeReadiness.js";
import { resolveTelegramRuntimeConfig } from "../modules/telegramConfig.js";

function main() {
  loadRuntimeEnvFile();

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
  const SOCKET_PATH = process.env.LOBSTER_SOCKET_PATH ?? "/tmp/lobster/lobsterd.sock";
  const DATA_PATH = process.env.LOBSTER_DATA_PATH ?? "/tmp/lobster/lobster.sqlite";

  const profiles = loadModelProfiles(MODELS_PATH);
  const telegram = resolveTelegramRuntimeConfig();
  const chatPlugins = loadChatPluginRegistry(CHAT_PLUGINS_PATH);
  const report = buildRuntimeReadinessReport({
    bridgeBinaryPath: process.env.LOBSTER_BRIDGE_BIN,
    chatPlugins,
    dataPath: DATA_PATH,
    profiles,
    socketPath: SOCKET_PATH,
    telegram
  });

  console.log("Lobster Runtime Doctor");
  console.log(`Generated at: ${report.generatedAt}`);
  console.log(`Summary: ok=${report.summary.ok} warn=${report.summary.warn} fail=${report.summary.fail}`);
  console.log("");

  for (const check of report.checks) {
    console.log(redactSecrets(formatCheck(check)));
    if (check.suggestion) {
      console.log(`   suggestion: ${redactSecrets(check.suggestion)}`);
    }
  }

  const enabledChatApps = getEnabledChatPluginApplications(chatPlugins);
  console.log("");
  console.log(`Enabled chat apps: ${enabledChatApps.length > 0 ? enabledChatApps.join(", ") : "(none)"}`);

  if (report.summary.fail > 0) {
    process.exitCode = 2;
    return;
  }

  if (report.summary.warn > 0) {
    if (process.env.LOBSTER_DOCTOR_WARN_AS_ERROR === "1") {
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
    return;
  }

  process.exitCode = 0;
}

function formatCheck(check: RuntimeReadinessCheck) {
  const prefix = check.level === "ok" ? "[OK]" : check.level === "warn" ? "[WARN]" : "[FAIL]";
  return `${prefix} ${check.id}: ${check.message}`;
}

function redactSecrets(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, mask)
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, mask);
}

function mask(secret: string) {
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

main();

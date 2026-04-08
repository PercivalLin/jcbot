import { resolveTelegramRuntimeConfig } from "../modules/telegramConfig.js";
import {
  normalizeTelegramBaseUrl,
  probeTelegramConnectivity,
  validateTelegramBaseUrl
} from "../modules/telegramDiagnostics.js";
import { resolveTelegramProxyUrl } from "../modules/telegramHttp.js";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";

async function main() {
  loadRuntimeEnvFile();

  const config = resolveTelegramRuntimeConfig();
  const proxyUrl = resolveTelegramProxyUrl();
  console.log("Telegram Connectivity Doctor");
  console.log(`baseURL: ${normalizeTelegramBaseUrl(config.baseUrl)}`);
  console.log(`proxy: ${proxyUrl ?? "(none)"}`);
  console.log(`token: ${config.botToken ? "configured" : "missing"}`);
  console.log("");

  const baseUrlIssue = validateTelegramBaseUrl(config.baseUrl);
  if (baseUrlIssue) {
    console.log(`[FAIL] baseURL: ${baseUrlIssue}`);
    console.log("suggestion: set LOBSTER_TELEGRAM_BASE_URL to host prefix only (example: https://api.telegram.org)");
    process.exitCode = 2;
    return;
  }

  const probe = await probeTelegramConnectivity(config, { timeoutMs: 8000 });
  if (probe.ok) {
    console.log(`[OK] connectivity: ${probe.message}`);
    process.exitCode = 0;
    return;
  }

  console.log(`[FAIL] connectivity: ${probe.message}`);
  if (probe.hint) {
    console.log(`suggestion: ${probe.hint}`);
  }
  process.exitCode = 2;
}

void main();

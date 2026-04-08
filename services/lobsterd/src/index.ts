import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelProfiles } from "./modules/config.js";
import { createBridgeClient } from "./modules/bridgeClient.js";
import { resolveWorkspaceConfigFile } from "./modules/paths.js";
import { ModelRouter } from "./modules/modelRouter.js";
import { loadRuntimeEnvFile } from "./modules/runtimeEnv.js";
import { resolveTelegramRuntimeConfig } from "./modules/telegramConfig.js";
import { startTelegramPollingIngress, type TelegramIngressCommand } from "./modules/telegramIngress.js";
import { sendTelegramTextMessage } from "./modules/telegramHttp.js";
import { normalizeTelegramChatReply } from "./modules/chatReply.js";
import { createTelegramRuntimeNotifierFromEnv } from "./modules/telegramNotifier.js";
import { acquireInstanceLock } from "./modules/instanceLock.js";
import {
  getEnabledChatPluginApplications,
  loadChatPluginRegistry
} from "./modules/chatPluginRegistry.js";
import { buildRuntimeReadinessReport } from "./modules/runtimeReadiness.js";
import { RpcServer } from "./ipc/rpcServer.js";
import { getKnownApplications } from "@lobster/skills";
import { createRuntimePersistence } from "@lobster/storage";

function parseKnownApplicationsFromEnv() {
  const raw = process.env.LOBSTER_KNOWN_APPS?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNotificationWhitelistFromEnv() {
  const raw = process.env.LOBSTER_NOTIFICATION_WHITELIST?.trim();
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export async function startLobsterd() {
  loadRuntimeEnvFile();
  const instanceLock = acquireInstanceLock();
  let lockReleased = false;
  const releaseInstanceLock = () => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    instanceLock.release();
  };

  try {
    const MODELS_PATH = resolveWorkspaceConfigFile({
      importMetaUrl: import.meta.url,
      name: "models.yaml",
      override: process.env.LOBSTER_MODELS_PATH
    });
    const SOCKET_PATH = process.env.LOBSTER_SOCKET_PATH ?? "/tmp/lobster/lobsterd.sock";
    const DATA_PATH = process.env.LOBSTER_DATA_PATH ?? "/tmp/lobster/lobster.sqlite";
    const CHAT_PLUGINS_PATH =
      resolveWorkspaceConfigFile({
        importMetaUrl: import.meta.url,
        name: "chat_plugins.yaml",
        override: process.env.LOBSTER_CHAT_PLUGINS_PATH
      });
    const telegramConfig = resolveTelegramRuntimeConfig();
    const profiles = loadModelProfiles(MODELS_PATH);
    const router = new ModelRouter(profiles);
    const persistence = await createRuntimePersistence({ path: DATA_PATH });
    const bridgeClient = createBridgeClient();
    const chatPluginInstances = loadChatPluginRegistry(CHAT_PLUGINS_PATH);
    const chatPluginApplications = getEnabledChatPluginApplications(chatPluginInstances);
    const notificationWhitelist =
      parseNotificationWhitelistFromEnv() ??
      Array.from(new Set([...chatPluginApplications, "Mail", "Calendar"]));
    const knownApplications = getKnownApplications({
      extraApplications: [
        ...parseKnownApplicationsFromEnv(),
        ...chatPluginApplications
      ]
    });
    try {
      await bridgeClient.configureKnownApplications(knownApplications);
    } catch (error) {
      console.warn(
        `Failed to configure known application catalog on bridge: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const runtimeReadinessProvider = async () => {
      let bridgeCapabilities;
      try {
        bridgeCapabilities = await bridgeClient.describeCapabilities();
      } catch {
        bridgeCapabilities = undefined;
      }

      return buildRuntimeReadinessReport({
        bridgeBinaryPath: process.env.LOBSTER_BRIDGE_BIN,
        bridgeCapabilities,
        chatPlugins: chatPluginInstances,
        dataPath: DATA_PATH,
        telegram: telegramConfig,
        profiles,
        socketPath: SOCKET_PATH
      });
    };

    const notifier = createTelegramRuntimeNotifierFromEnv(telegramConfig);
    const rpcServer = new RpcServer(SOCKET_PATH, router, persistence, bridgeClient, notifier, {
      chatPlugins: chatPluginInstances,
      notificationWhitelist,
      runtimeReadinessProvider
    });
    const rpcSocketServer = await rpcServer.start();
    console.log(`lobsterd listening on ${SOCKET_PATH} with ${persistence.backend} persistence`);
    console.log(`instance lock acquired on ${instanceLock.lockPath} (pid=${instanceLock.pid})`);

    const readiness = await runtimeReadinessProvider();
    console.log(
      `runtime readiness: ok=${readiness.summary.ok}, warn=${readiness.summary.warn}, fail=${readiness.summary.fail}`
    );

    const handleTelegramCommand = async (command: TelegramIngressCommand) => {
      switch (command.kind) {
        case "task.create": {
          traceChat(
            `[ingress][telegram][task] user=${maskIdentifier(command.request.userId)} text="${preview(command.request.text)}"`
          );
          await maybeSendTelegramTaskAck({
            chatId: command.request.userId,
            telegramConfig
          });
          const created = await rpcServer.createTask(command.request);
          traceChat(
            `[egress][runtime][task] run=${created.run.runId} status=${created.run.status}` +
              (created.approvalTicket ? ` approval=${created.approvalTicket.id}` : "")
          );
          return created;
        }
        case "chat.message": {
          if (!telegramConfig.botToken) {
            return undefined;
          }
          traceChat(
            `[ingress][telegram][chat] chat=${maskIdentifier(command.chatId)} text="${preview(command.text)}"`
          );
          await maybeSendTelegramTaskAck({
            chatId: command.chatId,
            telegramConfig
          });
          const rawReply = await router.prompt("planner", buildTelegramChatPrompt(command.text));
          const reply = normalizeTelegramChatReply(rawReply);
          traceChat(
            `[egress][runtime][chat] chat=${maskIdentifier(command.chatId)} mode=${
              isStubReply(rawReply) ? "stub" : "model"
            } text="${preview(reply)}"`
          );
          await sendTelegramTextMessage({
            baseUrl: telegramConfig.baseUrl,
            botToken: telegramConfig.botToken,
            chatId: command.chatId,
            text: reply
          });
          return undefined;
        }
        case "approval.approve":
          traceChat(
            `[ingress][telegram][approve] by=${maskIdentifier(command.approvedBy)} ticket=${command.ticketId}`
          );
          return rpcServer.approveTicket(command.ticketId, command.approvedBy);
        case "approval.deny":
          traceChat(`[ingress][telegram][deny] ticket=${command.ticketId}`);
          return rpcServer.denyTicket(command.ticketId);
      }
    };

    let closeTelegramIngress: (() => Promise<void>) | undefined;
    if (telegramConfig.botToken) {
      try {
        const ingress = await startTelegramPollingIngress({
          config: telegramConfig,
          onCommand: (command) => handleTelegramCommand(command),
          offsetStore: {
            get: (key) => persistence.getRuntimeValue(key),
            set: (key, value) => persistence.setRuntimeValue(key, value)
          }
        });
        closeTelegramIngress = () => ingress.close();
        console.log("chat ingress mode: telegram polling + local standalone");
      } catch (error) {
        console.warn(
          `telegram ingress failed to start: ${error instanceof Error ? error.message : String(error)}`
        );
        console.warn("Fallback mode: local standalone chat only.");
        console.log("chat ingress mode: local standalone (desktop + local CLI)");
      }
    } else {
      console.log("chat ingress mode: local standalone (desktop + local CLI)");
    }
    if (!telegramConfig.botToken) {
      console.log("telegram ingress disabled (missing LOBSTER_TELEGRAM_BOT_TOKEN).");
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      try {
        await new Promise<void>((resolve, reject) => {
          rpcSocketServer.close((error) => (error ? reject(error) : resolve()));
        });
        if (closeTelegramIngress) {
          await closeTelegramIngress();
        }
      } finally {
        releaseInstanceLock();
      }
      process.exit(0);
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    process.once("exit", () => releaseInstanceLock());
  } catch (error) {
    releaseInstanceLock();
    throw error;
  }
}

function buildTelegramChatPrompt(text: string) {
  return [
    "You are Lobster's chat mode assistant.",
    "Respond concisely and practically in Chinese by default.",
    "If user intent is to execute desktop actions, remind them to use `/do <instruction>`.",
    "If user asks about approvals, remind `/approve <ticketId>` and `/deny <ticketId>`.",
    `User message: ${text}`
  ].join("\n");
}

function traceChat(message: string) {
  if (process.env.LOBSTER_CHAT_TRACE === "0") {
    return;
  }
  console.log(message);
}

function preview(text: string, max = 180) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function maskIdentifier(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 6) {
    return trimmed;
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function isStubReply(text: string) {
  return /^\[stub:[^\]]+\]/.test(text.trim());
}

async function maybeSendTelegramTaskAck(params: {
  chatId: string;
  telegramConfig: ReturnType<typeof resolveTelegramRuntimeConfig>;
}) {
  if (!isTelegramTaskAckEnabled()) {
    return;
  }
  const token = params.telegramConfig.botToken?.trim();
  if (!token) {
    return;
  }

  try {
    await sendTelegramTextMessage({
      baseUrl: params.telegramConfig.baseUrl,
      botToken: token,
      chatId: params.chatId,
      text: "收到，正在处理你的指令..."
    });
    traceChat(`[egress][telegram][ack] chat=${maskIdentifier(params.chatId)} sent`);
  } catch (error) {
    traceChat(
      `[egress][telegram][ack] chat=${maskIdentifier(params.chatId)} failed=${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function isTelegramTaskAckEnabled() {
  const raw = process.env.LOBSTER_TELEGRAM_TASK_ACK?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "off", "no"].includes(raw);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  startLobsterd().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

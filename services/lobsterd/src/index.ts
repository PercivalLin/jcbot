import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskRun } from "@lobster/shared";
import { loadModelProfilesOrDefault } from "./modules/config.js";
import { createBridgeClient } from "./modules/bridgeClient.js";
import { resolveWorkspaceConfigFile } from "./modules/paths.js";
import { ModelRouter } from "./modules/modelRouter.js";
import { loadRuntimeEnvFile } from "./modules/runtimeEnv.js";
import { resolveTelegramRuntimeConfig } from "./modules/telegramConfig.js";
import { startTelegramPollingIngress, type TelegramIngressCommand } from "./modules/telegramIngress.js";
import { answerTelegramCallbackQuery, sendTelegramTextMessage } from "./modules/telegramHttp.js";
import { normalizeTelegramChatReply } from "./modules/chatReply.js";
import { createTelegramRuntimeNotifierFromEnv } from "./modules/telegramNotifier.js";
import { acquireInstanceLock } from "./modules/instanceLock.js";
import {
  getEnabledChatPluginApplications,
  loadChatPluginRegistry
} from "./modules/chatPluginRegistry.js";
import { buildRuntimeReadinessReport } from "./modules/runtimeReadiness.js";
import { readAdminConfigSnapshot } from "./modules/adminConfig.js";
import { AdminServer } from "./modules/adminServer.js";
import { RuntimeEventBus } from "./modules/runtimeEventBus.js";
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
    const ADMIN_PORT = readAdminConfigSnapshot().runtime.adminPort;
    const CHAT_PLUGINS_PATH =
      resolveWorkspaceConfigFile({
        importMetaUrl: import.meta.url,
        name: "chat_plugins.yaml",
        override: process.env.LOBSTER_CHAT_PLUGINS_PATH
      });
    let telegramConfig = resolveTelegramRuntimeConfig();
    let currentBridgeBin = process.env.LOBSTER_BRIDGE_BIN?.trim() || "";
    const router = new ModelRouter(loadModelProfilesOrDefault(MODELS_PATH));
    const persistence = await createRuntimePersistence({ path: DATA_PATH });
    const bridgeClient = createBridgeClient();
    const runtimeEventBus = new RuntimeEventBus();
    const chatPluginInstances = loadChatPluginRegistry(CHAT_PLUGINS_PATH);
    const chatPluginApplications = getEnabledChatPluginApplications(chatPluginInstances);
    const notificationWhitelist =
      parseNotificationWhitelistFromEnv() ??
      Array.from(new Set([...chatPluginApplications, "Mail", "Calendar"]));
    const configureKnownApplications = async () => {
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
    };
    await configureKnownApplications();

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
        profiles: router.listProfiles(),
        socketPath: SOCKET_PATH
      });
    };

    const notifier = createTelegramRuntimeNotifierFromEnv(() => telegramConfig, persistence);
    const rpcServer = new RpcServer(SOCKET_PATH, router, persistence, bridgeClient, notifier, {
      chatPlugins: chatPluginInstances,
      eventBus: runtimeEventBus,
      notificationWhitelist,
      runtimeReadinessProvider
    });
    const rpcSocketServer = await rpcServer.start();
    let adminServer: AdminServer | undefined;
    let closeTelegramIngress: (() => Promise<void>) | undefined;
    console.log(`lobsterd listening on ${SOCKET_PATH} with ${persistence.backend} persistence`);
    console.log(`admin console listening on http://127.0.0.1:${ADMIN_PORT}`);
    console.log(`instance lock acquired on ${instanceLock.lockPath} (pid=${instanceLock.pid})`);

    const readiness = await runtimeReadinessProvider();
    console.log(
      `runtime readiness: ok=${readiness.summary.ok}, warn=${readiness.summary.warn}, fail=${readiness.summary.fail}`
    );

    const publishReadiness = async () => {
      if (!adminServer) {
        return;
      }
      adminServer.publish({
        event: "readiness.updated",
        data: await runtimeReadinessProvider()
      });
    };

    const handleTelegramCommand = async (command: TelegramIngressCommand) => {
      switch (command.kind) {
        case "task.create": {
          traceChat(
            `[ingress][telegram][task] user=${maskIdentifier(command.request.userId)} text="${preview(command.request.text)}"`
          );
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
        case "approval.approve": {
          traceChat(
            `[ingress][telegram][approve] by=${maskIdentifier(command.approvedBy)} ticket=${command.ticketId}`
          );
          if (command.callbackQueryId && telegramConfig.botToken) {
            await safeAnswerCallbackQuery(telegramConfig, command.callbackQueryId, "正在继续执行");
          }
          return rpcServer.approveTicket(command.ticketId, command.approvedBy);
        }
        case "approval.deny":
          traceChat(`[ingress][telegram][deny] ticket=${command.ticketId}`);
          if (command.callbackQueryId && telegramConfig.botToken) {
            await safeAnswerCallbackQuery(telegramConfig, command.callbackQueryId, "已拒绝该操作");
          }
          return rpcServer.denyTicket(command.ticketId);
        case "run.status": {
          if (!telegramConfig.botToken) {
            return undefined;
          }
          const run = command.runId
            ? await rpcServer.getRun(command.runId)
            : (await rpcServer.listRuns()).find(
                (candidate) =>
                  candidate.request.source === "telegram" && candidate.request.userId === command.chatId
              );
          const events = run ? await rpcServer.listRunEvents(run.runId) : [];
          await sendTelegramTextMessage({
            baseUrl: telegramConfig.baseUrl,
            botToken: telegramConfig.botToken,
            chatId: command.chatId,
            text: formatRunStatusMessage(run, events)
          });
          return run;
        }
      }
    };

    const restartTelegramIngress = async () => {
      if (closeTelegramIngress) {
        await closeTelegramIngress();
        closeTelegramIngress = undefined;
      }

      if (!telegramConfig.botToken) {
        console.log("telegram ingress disabled (missing LOBSTER_TELEGRAM_BOT_TOKEN).");
        return;
      }

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
    };

    runtimeEventBus.subscribe((event) => {
      adminServer?.publish({
        event: "run.event",
        data: event
      });
      if (event.event.kind === "approval.requested" || event.event.kind === "approval.resolved") {
        adminServer?.publish({
          event: "approval.updated",
          data: event
        });
      }
    });

    adminServer = new AdminServer(ADMIN_PORT, {
      bridgeCapabilitiesProvider: async () => {
        try {
          return await bridgeClient.describeCapabilities();
        } catch {
          return undefined;
        }
      },
      csrfToken: randomUUID(),
      onModelsUpdated: async (profiles) => {
        router.replaceProfiles(profiles);
        await publishReadiness();
      },
      onRuntimeConfigUpdated: async (snapshot) => {
        const bridgeBin = snapshot.runtime.bridgeBin.trim();
        if (bridgeBin && bridgeBin !== currentBridgeBin) {
          await bridgeClient.restart?.({
            command: bridgeBin,
            args: parseBridgeArgsFromEnv()
          });
          currentBridgeBin = bridgeBin;
        }
        telegramConfig = resolveTelegramRuntimeConfig();
        await configureKnownApplications();
        await restartTelegramIngress();
        await publishReadiness();
      },
      rpcServer,
      runtimeReadinessProvider
    });
    await adminServer.start();
    await restartTelegramIngress();
    const readinessInterval = setInterval(() => {
      void publishReadiness();
    }, 15_000);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      try {
        clearInterval(readinessInterval);
        await new Promise<void>((resolve, reject) => {
          rpcSocketServer.close((error) => (error ? reject(error) : resolve()));
        });
        if (closeTelegramIngress) {
          await closeTelegramIngress();
        }
        if (adminServer) {
          await adminServer.close();
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

function parseBridgeArgsFromEnv() {
  return process.env.LOBSTER_BRIDGE_ARGS?.split(" ").map((value) => value.trim()).filter(Boolean) ?? [];
}

async function safeAnswerCallbackQuery(
  telegramConfig: ReturnType<typeof resolveTelegramRuntimeConfig>,
  callbackQueryId: string,
  text: string
) {
  if (!telegramConfig.botToken) {
    return;
  }

  try {
    await answerTelegramCallbackQuery({
      baseUrl: telegramConfig.baseUrl,
      botToken: telegramConfig.botToken,
      callbackQueryId,
      text
    });
  } catch (error) {
    traceChat(
      `[egress][telegram][callback] failed=${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function formatRunStatusMessage(run: TaskRun | undefined, events: Array<{ createdAt: string; message: string }>) {
  if (!run) {
    return "当前没有找到相关任务。";
  }

  const step = run.currentStepId ? run.plan.find((entry) => entry.id === run.currentStepId) : undefined;
  const recentEvents = events
    .slice(-3)
    .map((event) => `- ${event.createdAt}: ${event.message}`)
    .join("\n");

  return [
    `Task ${run.runId.slice(0, 8)}`,
    `Status: ${run.status}`,
    step ? `Current step: ${step.title}` : "Current step: pending",
    run.outcomeSummary ? `Summary: ${run.outcomeSummary}` : undefined,
    recentEvents ? `Recent events:\n${recentEvents}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
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

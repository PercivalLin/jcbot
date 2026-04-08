import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@lobster/shared";
import { buildRuntimeReadinessReport } from "./runtimeReadiness.js";

const baseProfiles: Record<ModelProfile["role"], ModelProfile> = {
  planner: {
    role: "planner",
    provider: "openai",
    modelId: "gpt-4.1",
    timeoutMs: 1000,
    apiKeyRef: "LOBSTER_TEST_OPENAI_KEY",
    budget: { inputTokens: 1000, outputTokens: 300 },
    fallback: []
  },
  vision: {
    role: "vision",
    provider: "anthropic",
    modelId: "claude-3-7-sonnet-latest",
    timeoutMs: 1000,
    apiKeyRef: "LOBSTER_TEST_ANTHROPIC_KEY",
    budget: { inputTokens: 1000, outputTokens: 300 },
    fallback: []
  },
  executor: {
    role: "executor",
    provider: "google",
    modelId: "gemini-2.0-flash",
    timeoutMs: 1000,
    apiKeyRef: "LOBSTER_TEST_GOOGLE_KEY",
    budget: { inputTokens: 1000, outputTokens: 300 },
    fallback: []
  },
  critic: {
    role: "critic",
    provider: "openai-compatible",
    modelId: "qwen2.5",
    baseURL: "http://localhost:11434/v1",
    timeoutMs: 1000,
    budget: { inputTokens: 1000, outputTokens: 300 },
    fallback: []
  }
};

describe("buildRuntimeReadinessReport", () => {
  it("keeps local openai-compatible critic as ready without key", () => {
    const report = buildRuntimeReadinessReport({
      socketPath: "/tmp/lobster/lobsterd.sock",
      dataPath: "/tmp/lobster/runtime.sqlite",
      bridgeBinaryPath: undefined,
      bridgeCapabilities: undefined,
      profiles: baseProfiles,
      chatPlugins: [
        {
          id: "wechat-main",
          appName: "WeChat",
          aliases: ["微信"],
          channel: "chat-app",
          enabled: true,
          capabilities: ["external.select_contact", "ui.type_into_target"],
          strategy: {
            attachmentButtonLabels: ["附件"],
            composerLabels: ["输入消息"],
            contactSearchLabels: ["搜索"],
            sendButtonLabels: ["发送"]
          }
        }
      ]
    });

    const criticCheck = report.checks.find((check) => check.id === "models.critic");
    expect(criticCheck?.level).toBe("ok");
    expect(criticCheck?.message).toContain("openai-compatible");
  });

  it("warns when all remote model credentials are missing", () => {
    const report = buildRuntimeReadinessReport({
      socketPath: "/tmp/lobster/lobsterd.sock",
      dataPath: "/tmp/lobster/runtime.sqlite",
      bridgeBinaryPath: undefined,
      bridgeCapabilities: undefined,
      profiles: baseProfiles,
      chatPlugins: []
    });

    const warnedModelChecks = report.checks.filter(
      (check) => check.id.startsWith("models.") && check.level === "warn"
    );
    expect(warnedModelChecks.length).toBeGreaterThanOrEqual(3);
    expect(report.summary.warn).toBeGreaterThan(0);
  });

  it("reports local and telegram ingress when telegram config is provided", () => {
    const report = buildRuntimeReadinessReport({
      socketPath: "/tmp/lobster/lobsterd.sock",
      dataPath: "/tmp/lobster/runtime.sqlite",
      bridgeBinaryPath: undefined,
      bridgeCapabilities: undefined,
      profiles: baseProfiles,
      telegram: {
        botToken: "telegram-token",
        baseUrl: "https://api.telegram.org",
        pollIntervalMs: 1000,
        textMode: "task"
      },
      chatPlugins: []
    });

    const localIngress = report.checks.find((check) => check.id === "chat.ingress.local");
    const telegramIngress = report.checks.find((check) => check.id === "telegram.ingress");
    expect(localIngress?.level).toBe("ok");
    expect(telegramIngress?.level).toBe("ok");
  });

  it("warns when telegram ingress is not configured", () => {
    const report = buildRuntimeReadinessReport({
      socketPath: "/tmp/lobster/lobsterd.sock",
      dataPath: "/tmp/lobster/runtime.sqlite",
      bridgeBinaryPath: undefined,
      bridgeCapabilities: undefined,
      profiles: baseProfiles,
      telegram: {
        botToken: undefined,
        baseUrl: "https://api.telegram.org",
        pollIntervalMs: 1000,
        textMode: "task"
      },
      chatPlugins: []
    });

    const telegramIngress = report.checks.find((check) => check.id === "telegram.ingress");
    expect(telegramIngress?.level).toBe("warn");
    expect(telegramIngress?.message).toContain("disabled");
  });

  it("does not leak raw key when apiKeyRef is misconfigured", () => {
    const report = buildRuntimeReadinessReport({
      socketPath: "/tmp/lobster/lobsterd.sock",
      dataPath: "/tmp/lobster/runtime.sqlite",
      bridgeBinaryPath: undefined,
      bridgeCapabilities: undefined,
      profiles: {
        ...baseProfiles,
        planner: {
          ...baseProfiles.planner,
          provider: "openai-compatible",
          apiKeyRef: "sk-1234567890abcdefghijklmnop"
        }
      },
      telegram: {
        botToken: undefined,
        baseUrl: "https://api.telegram.org",
        pollIntervalMs: 1000,
        textMode: "task"
      },
      chatPlugins: []
    });

    const plannerCheck = report.checks.find((check) => check.id === "models.planner");
    expect(plannerCheck?.level).toBe("warn");
    expect(plannerCheck?.suggestion).toContain("OPENAI_COMPATIBLE_API_KEY");
    expect(plannerCheck?.suggestion).not.toContain("sk-1234567890abcdefghijklmnop");
  });
});

import { describe, expect, it } from "vitest";
import { buildRuntimeEnvContent } from "./bootstrap.js";

describe("buildRuntimeEnvContent", () => {
  it("writes telegram proxy only when a proxy URL is provided", () => {
    const contentWithProxy = buildRuntimeEnvContent({
      bridgeBin: "/usr/local/bin/bridge",
      dataPath: "/tmp/lobster/runtime.sqlite",
      keyValues: new Map([["OPENAI_COMPATIBLE_API_KEY", "secret"]]),
      socketPath: "/tmp/lobster/lobsterd.sock",
      telegramAllowedChatIds: "123,456",
      telegramBaseUrl: "https://api.telegram.org",
      nodeExtraCaCerts: "",
      telegramProxyUrl: "http://127.0.0.1:7897",
      telegramToken: "telegram-token"
    });

    expect(contentWithProxy).toContain("LOBSTER_TELEGRAM_PROXY_URL=http://127.0.0.1:7897");

    const contentWithoutProxy = buildRuntimeEnvContent({
      bridgeBin: "/usr/local/bin/bridge",
      dataPath: "/tmp/lobster/runtime.sqlite",
      keyValues: new Map([["OPENAI_COMPATIBLE_API_KEY", "secret"]]),
      socketPath: "/tmp/lobster/lobsterd.sock",
      telegramAllowedChatIds: "123,456",
      telegramBaseUrl: "https://api.telegram.org",
      nodeExtraCaCerts: "",
      telegramProxyUrl: "",
      telegramToken: "telegram-token"
    });

    expect(contentWithoutProxy).not.toContain("LOBSTER_TELEGRAM_PROXY_URL=");
    expect(contentWithoutProxy).toContain("LOBSTER_TELEGRAM_BOT_TOKEN=telegram-token");
  });
});

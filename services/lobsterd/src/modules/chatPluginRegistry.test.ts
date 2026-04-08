import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getEnabledChatPluginApplications, loadChatPluginRegistry } from "./chatPluginRegistry.js";

describe("chatPluginRegistry", () => {
  it("falls back to default chat plugin instances when config file is missing", () => {
    const missingPath = join(tmpdir(), `lobster-chat-plugin-${Date.now()}-missing.yaml`);
    const instances = loadChatPluginRegistry(missingPath);

    expect(instances.length).toBeGreaterThan(0);
    expect(instances.some((instance) => instance.appName === "WeChat")).toBe(true);
    expect(instances.every((instance) => instance.enabled)).toBe(true);
    expect(instances.every((instance) => instance.strategy.composerLabels.length > 0)).toBe(true);
  });

  it("loads and normalizes explicit plugin instances from yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-chat-plugin-"));
    const configPath = join(dir, "chat_plugins.yaml");

    writeFileSync(
      configPath,
      [
        "version: 1",
        "instances:",
        "  - id: wechat-main",
        "    appName: WeChat",
        "    aliases: [微信, Wechat]",
        "    enabled: true",
        "    capabilities: [external.select_contact, ui.type_into_target]",
        "    strategy:",
        "      composerLabels: [输入, Chat Input]",
        "      contactSearchLabels: [搜索]",
        "  - appName: WhatsApp",
        "    enabled: false",
        "  - appName: WeChat",
        "    id: wechat-main",
        "    enabled: true"
      ].join("\n"),
      "utf8"
    );

    const instances = loadChatPluginRegistry(configPath);
    expect(instances.length).toBe(2);
    expect(instances[0]?.strategy.composerLabels).toContain("输入");
    expect(instances[0]?.strategy.contactSearchLabels).toContain("搜索");
    expect(instances[0]?.strategy.sendButtonLabels.length).toBeGreaterThan(0);

    const enabledApps = getEnabledChatPluginApplications(instances);
    expect(enabledApps).toContain("WeChat");
    expect(enabledApps).toContain("微信");
    expect(enabledApps).not.toContain("WhatsApp");
  });
});

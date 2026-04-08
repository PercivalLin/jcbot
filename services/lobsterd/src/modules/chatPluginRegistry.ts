import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { DEFAULT_CHAT_APP_PLUGIN_TARGETS } from "@lobster/skills";

export type ChatPluginInstance = {
  aliases: string[];
  appName: string;
  capabilities: string[];
  channel: "chat-app";
  enabled: boolean;
  id: string;
  strategy: ChatPluginStrategy;
};

export type ChatPluginStrategy = {
  attachmentButtonLabels: string[];
  composerLabels: string[];
  contactSearchLabels: string[];
  sendButtonLabels: string[];
};

type RawChatPluginConfig = {
  instances?: RawChatPluginInstance[];
  version?: number;
};

type RawChatPluginInstance = {
  aliases?: string[];
  appName?: string;
  capabilities?: string[];
  channel?: string;
  enabled?: boolean;
  id?: string;
  strategy?: {
    attachmentButtonLabels?: string[];
    composerLabels?: string[];
    contactSearchLabels?: string[];
    sendButtonLabels?: string[];
  };
};

const DEFAULT_CAPABILITIES = [
  "external.select_contact",
  "ui.type_into_target",
  "ui.click_target"
] as const;

const DEFAULT_CHAT_PLUGIN_STRATEGY: ChatPluginStrategy = {
  attachmentButtonLabels: ["Attach", "附件", "发送文件", "+"],
  composerLabels: ["Message", "消息", "输入", "输入消息"],
  contactSearchLabels: ["Search", "搜索", "联系人", "Contact"],
  sendButtonLabels: ["Send", "发送"]
};

export function defaultChatPluginInstances(): ChatPluginInstance[] {
  return DEFAULT_CHAT_APP_PLUGIN_TARGETS.map((appName) => ({
    aliases: [],
    appName,
    capabilities: [...DEFAULT_CAPABILITIES],
    channel: "chat-app",
    enabled: true,
    id: buildDefaultInstanceId(appName),
    strategy: defaultStrategy()
  }));
}

export function loadChatPluginRegistry(path: string): ChatPluginInstance[] {
  if (!existsSync(path)) {
    return defaultChatPluginInstances();
  }

  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw) as RawChatPluginConfig | undefined;
  const instances = parsed?.instances ?? [];
  if (instances.length === 0) {
    return defaultChatPluginInstances();
  }

  const normalized = instances
    .map((instance) => normalizeInstance(instance))
    .filter((instance): instance is ChatPluginInstance => Boolean(instance));

  if (normalized.length === 0) {
    return defaultChatPluginInstances();
  }

  return dedupeInstances(normalized);
}

export function getEnabledChatPluginApplications(instances: ChatPluginInstance[]) {
  const values = instances
    .filter((instance) => instance.enabled)
    .flatMap((instance) => [instance.appName, ...instance.aliases]);
  return dedupeCaseInsensitive(values);
}

function normalizeInstance(instance: RawChatPluginInstance): ChatPluginInstance | undefined {
  const appName = instance.appName?.trim();
  if (!appName) {
    return undefined;
  }

  const id = instance.id?.trim() || buildDefaultInstanceId(appName);
  const aliases = dedupeCaseInsensitive(instance.aliases ?? []);
  const capabilities = dedupeCaseInsensitive(instance.capabilities ?? [...DEFAULT_CAPABILITIES]);
  const strategy = mergeStrategy(instance.strategy);

  return {
    aliases,
    appName,
    capabilities,
    channel: "chat-app",
    enabled: instance.enabled ?? true,
    id,
    strategy
  };
}

function mergeStrategy(strategy: RawChatPluginInstance["strategy"]): ChatPluginStrategy {
  return {
    attachmentButtonLabels: dedupeCaseInsensitive(
      strategy?.attachmentButtonLabels ?? DEFAULT_CHAT_PLUGIN_STRATEGY.attachmentButtonLabels
    ),
    composerLabels: dedupeCaseInsensitive(
      strategy?.composerLabels ?? DEFAULT_CHAT_PLUGIN_STRATEGY.composerLabels
    ),
    contactSearchLabels: dedupeCaseInsensitive(
      strategy?.contactSearchLabels ?? DEFAULT_CHAT_PLUGIN_STRATEGY.contactSearchLabels
    ),
    sendButtonLabels: dedupeCaseInsensitive(
      strategy?.sendButtonLabels ?? DEFAULT_CHAT_PLUGIN_STRATEGY.sendButtonLabels
    )
  };
}

function dedupeInstances(instances: ChatPluginInstance[]) {
  const seen = new Set<string>();
  const result: ChatPluginInstance[] = [];

  for (const instance of instances) {
    const key = instance.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(instance);
  }

  return result;
}

function dedupeCaseInsensitive(values: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of values) {
    const value = raw.trim();
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function buildDefaultInstanceId(appName: string) {
  return `chat-${appName.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "app"}`;
}

function defaultStrategy(): ChatPluginStrategy {
  return {
    attachmentButtonLabels: [...DEFAULT_CHAT_PLUGIN_STRATEGY.attachmentButtonLabels],
    composerLabels: [...DEFAULT_CHAT_PLUGIN_STRATEGY.composerLabels],
    contactSearchLabels: [...DEFAULT_CHAT_PLUGIN_STRATEGY.contactSearchLabels],
    sendButtonLabels: [...DEFAULT_CHAT_PLUGIN_STRATEGY.sendButtonLabels]
  };
}

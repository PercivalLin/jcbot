import { createHash } from "node:crypto";
import type { InboxItem, TaskRequest } from "@lobster/shared";
import { getChatPluginApplications } from "@lobster/skills";

export type NotificationSignal = {
  app: string;
  title?: string;
  body?: string;
  timestamp: string;
};

const chatPluginTargets = getChatPluginApplications();

const DEFAULT_NOTIFICATION_WHITELIST = new Set([
  ...chatPluginTargets,
  "Mail",
  "Calendar"
]);

type InboxEngineOptions = {
  notificationWhitelist?: string[];
};

function parseWhitelistFromEnv() {
  const raw = process.env.LOBSTER_NOTIFICATION_WHITELIST?.trim();
  if (!raw) {
    return undefined;
  }

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

export class InboxEngine {
  private readonly items: InboxItem[] = [];
  private readonly notificationWhitelist: Set<string>;

  constructor(options: InboxEngineOptions = {}) {
    const configured = options.notificationWhitelist ?? parseWhitelistFromEnv();
    this.notificationWhitelist = new Set(configured ?? DEFAULT_NOTIFICATION_WHITELIST);
  }

  hydrate(items: InboxItem[]) {
    this.items.splice(0, this.items.length, ...items);
  }

  list() {
    return [...this.items];
  }

  upsert(item: InboxItem) {
    const index = this.items.findIndex((candidate) => candidate.itemId === item.itemId);
    if (index === -1) {
      this.items.unshift(item);
      return item;
    }

    this.items[index] = item;
    return item;
  }

  acceptNotification(signal: NotificationSignal): { item?: InboxItem; followup?: TaskRequest } {
    if (!this.notificationWhitelist.has(signal.app)) {
      return {};
    }

    const fingerprint = fingerprintNotification(signal);

    const item: InboxItem = {
      itemId: `notification:${fingerprint}`,
      sourceApp: signal.app,
      sourceType: "notification",
      summary: `${signal.title ?? signal.app}: ${signal.body ?? "Notification detected"}`,
      priority: "normal",
      riskLevel: "green",
      state: "new",
      createdAt: signal.timestamp
    };

    this.upsert(item);

    const followup: TaskRequest = {
      id: `notification:${fingerprint}`,
      source: "notification",
      userId: "system",
      text: `Open ${signal.app} and inspect the context behind this notification: ${signal.title ?? ""} ${signal.body ?? ""}`.trim(),
      attachments: [],
      riskPreference: "auto",
      createdAt: signal.timestamp
    };

    return { item, followup };
  }
}

function fingerprintNotification(signal: NotificationSignal) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        app: signal.app,
        body: signal.body ?? "",
        timestamp: signal.timestamp,
        title: signal.title ?? ""
      })
    )
    .digest("hex")
    .slice(0, 20);
}

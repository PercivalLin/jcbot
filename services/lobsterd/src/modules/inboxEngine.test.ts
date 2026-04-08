import { describe, expect, it } from "vitest";
import { InboxEngine } from "./inboxEngine.js";

describe("InboxEngine", () => {
  it("accepts whitelisted notifications and creates a follow-up task", () => {
    const inbox = new InboxEngine();
    const result = inbox.acceptNotification({
      app: "WhatsApp",
      title: "Alice",
      body: "Ping",
      timestamp: new Date().toISOString()
    });

    expect(result.item?.sourceApp).toBe("WhatsApp");
    expect(result.followup?.source).toBe("notification");
  });

  it("ignores non-whitelisted notifications", () => {
    const inbox = new InboxEngine();
    const result = inbox.acceptNotification({
      app: "RandomApp",
      timestamp: new Date().toISOString()
    });

    expect(result.item).toBeUndefined();
    expect(result.followup).toBeUndefined();
  });

  it("supports explicit whitelist overrides for plugin adapters", () => {
    const inbox = new InboxEngine({
      notificationWhitelist: ["Signal"]
    });
    const allowed = inbox.acceptNotification({
      app: "Signal",
      timestamp: new Date().toISOString()
    });
    const blocked = inbox.acceptNotification({
      app: "WhatsApp",
      timestamp: new Date().toISOString()
    });

    expect(allowed.item?.sourceApp).toBe("Signal");
    expect(blocked.item).toBeUndefined();
  });
});

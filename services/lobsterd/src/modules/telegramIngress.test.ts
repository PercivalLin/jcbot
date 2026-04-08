import { describe, expect, it } from "vitest";
import { decodeTelegramUpdate, normalizeTelegramCommand, normalizeTelegramCommandWithMode } from "./telegramIngress.js";

describe("telegramIngress", () => {
  it("decodes Telegram text message update", () => {
    const event = decodeTelegramUpdate({
      update_id: 123,
      message: {
        chat: { id: 999 },
        text: "open finder"
      }
    });

    expect(event?.chatId).toBe("999");
    expect(event?.eventId).toBe("123");
    expect(event?.text).toBe("open finder");
  });

  it("ignores update when chat is not in allowlist", () => {
    const event = decodeTelegramUpdate(
      {
        update_id: 123,
        message: {
          chat: { id: 999 },
          text: "hello"
        }
      },
      new Set(["888"])
    );
    expect(event).toBeUndefined();
  });

  it("maps approval command from Telegram text", () => {
    const command = normalizeTelegramCommand({
      chatId: "999",
      eventId: "evt_1",
      receivedAt: new Date().toISOString(),
      text: "/approve ticket-123456"
    });

    expect(command.kind).toBe("approval.approve");
    if (command.kind === "approval.approve") {
      expect(command.chatId).toBe("999");
      expect(command.ticketId).toBe("ticket-123456");
      expect(command.approvedBy).toBe("999");
    }
  });

  it("maps inline approval callback payloads", () => {
    const command = normalizeTelegramCommand({
      callbackQueryId: "callback-1",
      chatId: "999",
      eventId: "evt_cb",
      receivedAt: new Date().toISOString(),
      text: "tg:approve:ticket-654321"
    });

    expect(command.kind).toBe("approval.approve");
    if (command.kind === "approval.approve") {
      expect(command.callbackQueryId).toBe("callback-1");
      expect(command.chatId).toBe("999");
      expect(command.ticketId).toBe("ticket-654321");
    }
  });

  it("maps /chat prefix to chat.message", () => {
    const command = normalizeTelegramCommandWithMode(
      {
        chatId: "999",
        eventId: "evt_2",
        receivedAt: new Date().toISOString(),
        text: "/chat 你好，今天怎么样？"
      },
      "task"
    );

    expect(command.kind).toBe("chat.message");
    if (command.kind === "chat.message") {
      expect(command.text).toContain("今天");
    }
  });

  it("maps /do prefix to task.create even in chat mode", () => {
    const command = normalizeTelegramCommandWithMode(
      {
        chatId: "999",
        eventId: "evt_3",
        receivedAt: new Date().toISOString(),
        text: "/do 打开 Finder"
      },
      "chat"
    );

    expect(command.kind).toBe("task.create");
    if (command.kind === "task.create") {
      expect(command.request.text).toContain("Finder");
    }
  });

  it("maps /status to run.status with optional run id", () => {
    const command = normalizeTelegramCommandWithMode(
      {
        chatId: "999",
        eventId: "evt_status",
        receivedAt: new Date().toISOString(),
        text: "/status run-abcdef12"
      },
      "hybrid"
    );

    expect(command.kind).toBe("run.status");
    if (command.kind === "run.status") {
      expect(command.chatId).toBe("999");
      expect(command.runId).toBe("run-abcdef12");
    }
  });

  it("maps non-operational message to chat.message in hybrid mode", () => {
    const command = normalizeTelegramCommandWithMode(
      {
        chatId: "999",
        eventId: "evt_4",
        receivedAt: new Date().toISOString(),
        text: "今天天气怎么样"
      },
      "hybrid"
    );
    expect(command.kind).toBe("chat.message");
  });

  it("maps operational message to task.create in hybrid mode", () => {
    const command = normalizeTelegramCommandWithMode(
      {
        chatId: "999",
        eventId: "evt_5",
        receivedAt: new Date().toISOString(),
        text: "打开 Telegram 然后点击 Search"
      },
      "hybrid"
    );
    expect(command.kind).toBe("task.create");
  });
});

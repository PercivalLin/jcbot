import { describe, expect, it } from "vitest";
import { normalizeTelegramChatReply } from "./chatReply.js";

describe("chatReply", () => {
  it("returns user-friendly fallback for stub replies", () => {
    const reply = normalizeTelegramChatReply("[stub:planner] You are Lobster's chat mode assistant.");
    expect(reply).toContain("当前聊天模型不可用");
    expect(reply).toContain("stub 模式");
    expect(reply).not.toContain("You are Lobster's chat mode assistant.");
  });

  it("preserves non-stub replies", () => {
    const reply = normalizeTelegramChatReply("  你好，我可以帮你规划下一步。  ");
    expect(reply).toBe("你好，我可以帮你规划下一步。");
  });

  it("returns fallback when reply is empty", () => {
    const reply = normalizeTelegramChatReply("   ");
    expect(reply).toContain("当前没有可用回复");
  });
});

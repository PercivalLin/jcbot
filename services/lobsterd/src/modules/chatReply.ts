const STUB_REPLY_PATTERN = /^\[stub:([a-zA-Z0-9_-]+)\]\s*/;

export function normalizeTelegramChatReply(rawReply: string) {
  const trimmed = rawReply.trim();
  if (!trimmed) {
    return "当前没有可用回复，请稍后重试。";
  }

  const stubMatch = STUB_REPLY_PATTERN.exec(trimmed);
  if (!stubMatch) {
    return trimmed;
  }

  const role = stubMatch[1] ?? "planner";
  return [
    `当前聊天模型不可用（${role} 处于 stub 模式）。`,
    "请检查模型 API Key 与 models.yaml 配置后重试。",
    "你也可以继续使用 `/do <指令>` 触发执行任务。"
  ].join("\n");
}

import type { CapabilityCandidate, SkillManifest } from "@lobster/shared";

export const DEFAULT_CHAT_APP_PLUGIN_TARGETS = [
  "WeChat",
  "WhatsApp",
  "Telegram",
  "Slack",
  "Discord",
  "Signal"
] as const;

export const STARTER_SKILLS: SkillManifest[] = [
  {
    name: "BrowserSkill",
    version: "0.1.0",
    kind: "declarative-workflow",
    allowedActions: ["ui.open_app", "ui.navigate", "ui.inspect", "ui.click", "ui.type_text"],
    requiredApps: ["Safari", "Google Chrome"],
    requiredPermissions: [],
    description: "General browser navigation and form-filling starter skill."
  },
  {
    name: "FinderSkill",
    version: "0.1.0",
    kind: "declarative-workflow",
    allowedActions: ["ui.open_app", "ui.navigate", "ui.inspect", "ui.read", "ui.drag_drop"],
    requiredApps: ["Finder"],
    requiredPermissions: [],
    description: "File discovery and preparation skill."
  },
  {
    name: "TerminalSkill",
    version: "0.1.0",
    kind: "declarative-workflow",
    allowedActions: ["ui.open_app", "ui.navigate", "ui.inspect", "ui.type_text"],
    requiredApps: ["Terminal", "iTerm2"],
    requiredPermissions: [],
    description: "Command drafting and safe shell execution preparation skill."
  },
  {
    name: "ChatAppPluginTemplate",
    version: "0.1.0",
    kind: "plugin",
    allowedActions: [
      "ui.open_app",
      "ui.navigate",
      "ui.inspect",
      "ui.read",
      "external.select_contact",
      "ui.type_into_target",
      "ui.click_target"
    ],
    requiredApps: [...DEFAULT_CHAT_APP_PLUGIN_TARGETS],
    requiredPermissions: [],
    description: "Generic chat-app plugin template. Concrete chat integrations are runtime plugin instances."
  },
  {
    name: "NotificationFollowupSkill",
    version: "0.1.0",
    kind: "composition-template",
    allowedActions: ["ui.inspect", "ui.open_app", "ui.navigate", "ui.read"],
    requiredApps: [],
    requiredPermissions: [],
    description: "Turn notification signals into low-risk follow-up tasks."
  }
];

export function isAutoPromotableCandidate(candidate: CapabilityCandidate): boolean {
  return (
    candidate.artifactType === "declarative-workflow" &&
    candidate.riskClass === "green" &&
    candidate.evalScore >= 0.9
  );
}

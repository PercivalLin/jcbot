import type { SkillManifest } from "@lobster/shared";
import { DEFAULT_CHAT_APP_PLUGIN_TARGETS, STARTER_SKILLS } from "./starterSkills.js";

export const CORE_KNOWN_APPLICATIONS = [
  "Finder",
  "Safari",
  "Google Chrome",
  "Terminal",
  "iTerm2",
  "Mail",
  "Calendar",
  "Notes",
  "Preview",
  "Xcode",
  "Visual Studio Code"
] as const;

const APPLICATION_ALIASES: Record<string, string> = {
  Chrome: "Google Chrome",
  "VS Code": "Visual Studio Code",
  微信: "WeChat",
  Weixin: "WeChat",
  weixin: "WeChat"
};

const APPLICATION_ALIAS_LOOKUP = new Map(
  Object.entries(APPLICATION_ALIASES).map(([alias, canonical]) => [alias.toLowerCase(), canonical])
);

type KnownApplicationsOptions = {
  starterSkills?: SkillManifest[];
  extraApplications?: string[];
};

export function getChatPluginApplications(starterSkills: SkillManifest[] = STARTER_SKILLS): string[] {
  const chatPluginTemplate = starterSkills.find(
    (skill) => skill.kind === "plugin" && skill.name === "ChatAppPluginTemplate"
  );
  const configured = chatPluginTemplate?.requiredApps?.length
    ? chatPluginTemplate.requiredApps
    : [...DEFAULT_CHAT_APP_PLUGIN_TARGETS];
  return uniqueCaseInsensitive(configured);
}

export function getKnownApplications(options: KnownApplicationsOptions = {}): string[] {
  return uniqueCaseInsensitive([
    ...CORE_KNOWN_APPLICATIONS,
    ...getChatPluginApplications(options.starterSkills ?? STARTER_SKILLS),
    ...(options.extraApplications ?? [])
  ]);
}

export function resolveApplicationAlias(applicationName: string): string {
  const trimmed = applicationName.trim();
  if (!trimmed) {
    return trimmed;
  }

  return APPLICATION_ALIASES[trimmed] ?? APPLICATION_ALIAS_LOOKUP.get(trimmed.toLowerCase()) ?? trimmed;
}

export function matchKnownApplication(text: string, options: KnownApplicationsOptions = {}): string | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const knownApplications = getKnownApplications(options);
  const canonical = knownApplications.find((candidate) => matchApplicationToken(text, candidate));
  if (canonical) {
    return canonical;
  }

  const alias = Object.entries(APPLICATION_ALIASES).find(([candidate]) => matchApplicationToken(text, candidate));
  return alias?.[1];
}

function uniqueCaseInsensitive(values: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = rawValue.trim();
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

function matchApplicationToken(text: string, candidate: string) {
  if (isBoundaryFriendlyCandidate(candidate)) {
    return new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "i").test(text);
  }

  return text.toLowerCase().includes(candidate.toLowerCase());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBoundaryFriendlyCandidate(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value);
}

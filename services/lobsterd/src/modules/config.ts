import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { modelProfileSchema, type ModelProfile } from "@lobster/shared";

type RawModelsConfig = {
  defaultProvider: string;
  profiles: Record<string, Omit<ModelProfile, "role">>;
};

export function createDefaultModelProfiles(): Record<ModelProfile["role"], ModelProfile> {
  return {
    planner: modelProfileSchema.parse({
      role: "planner",
      provider: "openai-compatible",
      modelId: "gpt-4.1",
      baseURL: "https://api.openai.com/v1",
      apiKeyRef: "OPENAI_COMPATIBLE_API_KEY",
      timeoutMs: 30_000,
      budget: {
        inputTokens: 16_000,
        outputTokens: 3_000
      },
      fallback: []
    }),
    vision: modelProfileSchema.parse({
      role: "vision",
      provider: "openai-compatible",
      modelId: "gpt-4.1",
      baseURL: "https://api.openai.com/v1",
      apiKeyRef: "OPENAI_COMPATIBLE_API_KEY",
      timeoutMs: 30_000,
      budget: {
        inputTokens: 12_000,
        outputTokens: 2_000
      },
      fallback: []
    }),
    executor: modelProfileSchema.parse({
      role: "executor",
      provider: "openai-compatible",
      modelId: "gpt-4.1-mini",
      baseURL: "https://api.openai.com/v1",
      apiKeyRef: "OPENAI_COMPATIBLE_API_KEY",
      timeoutMs: 20_000,
      budget: {
        inputTokens: 8_000,
        outputTokens: 1_500
      },
      fallback: []
    }),
    critic: modelProfileSchema.parse({
      role: "critic",
      provider: "openai-compatible",
      modelId: "gpt-4.1-mini",
      baseURL: "https://api.openai.com/v1",
      apiKeyRef: "OPENAI_COMPATIBLE_API_KEY",
      timeoutMs: 20_000,
      budget: {
        inputTokens: 8_000,
        outputTokens: 1_500
      },
      fallback: []
    })
  };
}

export function loadModelProfiles(path: string): Record<ModelProfile["role"], ModelProfile> {
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw) as RawModelsConfig;

  return {
    planner: modelProfileSchema.parse({ role: "planner", ...parsed.profiles.planner }),
    vision: modelProfileSchema.parse({ role: "vision", ...parsed.profiles.vision }),
    executor: modelProfileSchema.parse({ role: "executor", ...parsed.profiles.executor }),
    critic: modelProfileSchema.parse({ role: "critic", ...parsed.profiles.critic })
  };
}

export function loadModelProfilesOrDefault(path: string): Record<ModelProfile["role"], ModelProfile> {
  if (!existsSync(path)) {
    return createDefaultModelProfiles();
  }

  return loadModelProfiles(path);
}

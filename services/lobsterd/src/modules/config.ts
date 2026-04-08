import { readFileSync } from "node:fs";
import YAML from "yaml";
import { modelProfileSchema, type ModelProfile } from "@lobster/shared";

type RawModelsConfig = {
  defaultProvider: string;
  profiles: Record<string, Omit<ModelProfile, "role">>;
};

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


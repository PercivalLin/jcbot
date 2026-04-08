import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProfile } from "@lobster/shared";
import { loadModelProfiles } from "../modules/config.js";
import { ModelRouter } from "../modules/modelRouter.js";
import { resolveWorkspaceConfigFile } from "../modules/paths.js";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";

type ProbeOptions = {
  role: ModelProfile["role"];
  strict: boolean;
  text: string;
};

export async function runModelProbe(options: ProbeOptions) {
  loadRuntimeEnvFile();

  const modelsPath = resolveWorkspaceConfigFile({
    importMetaUrl: import.meta.url,
    name: "models.yaml",
    override: process.env.LOBSTER_MODELS_PATH
  });
  const router = new ModelRouter(loadModelProfiles(modelsPath));
  const profile = router.resolveProfile(options.role);

  console.log("Lobster Model Probe");
  console.log(`role: ${options.role}`);
  console.log(`provider: ${profile.provider}`);
  console.log(`model: ${profile.modelId}`);
  if (profile.provider === "openai-compatible") {
    console.log(`baseURL: ${profile.baseURL ?? "(none)"}`);
  }
  console.log("");
  console.log(`prompt: ${preview(options.text, 120)}`);

  const reply = await router.prompt(options.role, options.text);
  const isStub = /^\[stub:[^\]]+\]/.test(reply.trim());
  console.log(`result: ${isStub ? "stub" : "ok"}`);
  console.log(`reply: ${preview(reply, 280)}`);

  if (options.strict && isStub) {
    process.exitCode = 2;
  }
}

function parseArgs(argv: string[]): ProbeOptions {
  let role: ModelProfile["role"] = "planner";
  let text = "只回复 OK";
  let strict = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--role") {
      const next = argv[i + 1];
      if (next === "planner" || next === "vision" || next === "executor" || next === "critic") {
        role = next;
        i += 1;
      }
      continue;
    }
    if (arg === "--text") {
      const next = argv[i + 1];
      if (next !== undefined) {
        text = next;
        i += 1;
      }
      continue;
    }
    if (arg === "--strict") {
      strict = true;
    }
  }

  return {
    role,
    strict,
    text
  };
}

function preview(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runModelProbe(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

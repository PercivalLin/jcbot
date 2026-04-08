import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceConfigFile } from "../modules/paths.js";
import { parseEnvFile, resolveRuntimeEnvPath } from "../modules/runtimeEnv.js";

type ResetTarget = {
  path: string;
  reason: string;
};

type ResetOptions = {
  dryRun: boolean;
  yes: boolean;
};

const MODELS_PATH = resolveWorkspaceConfigFile({
  importMetaUrl: import.meta.url,
  name: "models.yaml",
  override: process.env.LOBSTER_MODELS_PATH
});
const RUNTIME_ENV_PATH = resolveRuntimeEnvPath();
const CONFIG_DIR = dirname(MODELS_PATH);
const WORKSPACE_ROOT = resolve(CONFIG_DIR, "..");

export async function runReset(options: ResetOptions) {
  const allTargets = collectResetTargets();
  const scoped: ResetTarget[] = [];
  const skipped: ResetTarget[] = [];

  for (const target of allTargets) {
    if (isPathWithin(WORKSPACE_ROOT, target.path)) {
      scoped.push(target);
    } else {
      skipped.push(target);
    }
  }

  console.log("Lobster Reset");
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log("");
  if (scoped.length === 0) {
    console.log("No removable config targets found in workspace.");
  } else {
    console.log("Targets:");
    for (const target of scoped) {
      console.log(`- ${target.path} (${target.reason})`);
    }
  }

  if (skipped.length > 0) {
    console.log("");
    console.log("Skipped (outside workspace):");
    for (const target of skipped) {
      console.log(`- ${target.path} (${target.reason})`);
    }
  }

  if (options.dryRun) {
    console.log("");
    console.log("Dry run complete. No files were removed.");
    return;
  }

  if (!options.yes) {
    if (!stdin.isTTY) {
      throw new Error("reset requires --yes when not running in an interactive shell.");
    }
    const proceed = await askYesNo("确认删除以上配置文件？", false);
    if (!proceed) {
      console.log("Cancelled. No files were removed.");
      return;
    }
  }

  const removed: string[] = [];
  const missing: string[] = [];

  for (const target of scoped) {
    if (!existsSync(target.path)) {
      missing.push(target.path);
      continue;
    }
    rmSync(target.path, { recursive: true, force: true });
    removed.push(target.path);
  }

  cleanupIfEmpty(resolve(CONFIG_DIR, "secrets"), removed);
  cleanupIfEmpty(resolve(CONFIG_DIR, "certs"), removed);

  console.log("");
  console.log(`Removed: ${removed.length}`);
  for (const path of removed) {
    console.log(`- ${path}`);
  }
  if (missing.length > 0) {
    console.log("");
    console.log(`Already missing: ${missing.length}`);
    for (const path of missing) {
      console.log(`- ${path}`);
    }
  }
  console.log("");
  console.log("Reset complete. Re-run `pnpm init:daemon` to bootstrap from scratch.");
}

function collectResetTargets() {
  const deduped = new Map<string, ResetTarget>();

  addTarget(deduped, RUNTIME_ENV_PATH, "runtime environment");
  addTarget(deduped, MODELS_PATH, "model profiles");

  if (existsSync(RUNTIME_ENV_PATH)) {
    const parsed = parseEnvFile(readFileSync(RUNTIME_ENV_PATH, "utf8"));
    const envDir = dirname(RUNTIME_ENV_PATH);
    for (const entry of parsed) {
      if (entry.key.endsWith("_FILE") && entry.value.trim()) {
        addTarget(deduped, resolve(envDir, entry.value.trim()), `${entry.key} target`);
      }
      if (entry.key === "NODE_EXTRA_CA_CERTS" && entry.value.trim()) {
        addTarget(deduped, resolve(envDir, entry.value.trim()), "TLS CA bundle");
      }
    }
  }

  if (existsSync(CONFIG_DIR)) {
    const names = readdirSync(CONFIG_DIR);
    for (const name of names) {
      if (name.startsWith("runtime.env.bak.") || name.startsWith("models.yaml.bak.")) {
        addTarget(deduped, resolve(CONFIG_DIR, name), "bootstrap backup");
      }
    }
  }

  return Array.from(deduped.values());
}

function addTarget(map: Map<string, ResetTarget>, path: string, reason: string) {
  map.set(path, { path, reason });
}

function cleanupIfEmpty(path: string, removed: string[]) {
  if (!existsSync(path)) {
    return;
  }
  if (!isPathWithin(WORKSPACE_ROOT, path)) {
    return;
  }
  if (readdirSync(path).length !== 0) {
    return;
  }
  rmSync(path, { recursive: true, force: true });
  removed.push(path);
}

function isPathWithin(base: string, target: string) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function askYesNo(question: string, defaultYes: boolean) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    while (true) {
      const answer = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
      if (!answer) {
        return defaultYes;
      }
      if (["y", "yes", "是", "1"].includes(answer)) {
        return true;
      }
      if (["n", "no", "否", "0"].includes(answer)) {
        return false;
      }
      console.log("请输入 y 或 n。");
    }
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): ResetOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes") || argv.includes("-y")
  };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  runReset(options).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

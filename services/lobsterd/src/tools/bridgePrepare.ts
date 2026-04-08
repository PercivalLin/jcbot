import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadRuntimeEnvFile, resolveRuntimeEnvPath } from "../modules/runtimeEnv.js";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(TOOL_DIR, "..", "..", "..", "..");
const NATIVE_BRIDGE_DIR = join(WORKSPACE_ROOT, "native", "lobster-bridge");
const DEFAULT_BRIDGE_BIN = join(NATIVE_BRIDGE_DIR, ".build", "release", "lobster-bridge");
const RUNTIME_ENV_PATH = resolveRuntimeEnvPath();
const DEFAULT_SWIFT_BIN = "/usr/bin/swift";
const FALLBACK_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export async function prepareBridgeBinary() {
  loadRuntimeEnvFile();

  const configuredBin = process.env.LOBSTER_BRIDGE_BIN?.trim();
  if (configuredBin && existsSync(configuredBin)) {
    console.log(`bridge ready (configured): ${configuredBin}`);
    return configuredBin;
  }

  if (existsSync(DEFAULT_BRIDGE_BIN)) {
    upsertRuntimeEnvValue(RUNTIME_ENV_PATH, "LOBSTER_BRIDGE_BIN", DEFAULT_BRIDGE_BIN);
    console.log(`bridge ready (detected): ${DEFAULT_BRIDGE_BIN}`);
    return DEFAULT_BRIDGE_BIN;
  }

  console.log("bridge binary not found, building native lobster-bridge...");
  const swiftCommand = resolveSwiftCommand();
  await runCommand(swiftCommand, ["build", "-c", "release"], NATIVE_BRIDGE_DIR);

  if (!existsSync(DEFAULT_BRIDGE_BIN)) {
    throw new Error(`bridge build completed but binary still missing: ${DEFAULT_BRIDGE_BIN}`);
  }

  upsertRuntimeEnvValue(RUNTIME_ENV_PATH, "LOBSTER_BRIDGE_BIN", DEFAULT_BRIDGE_BIN);
  console.log(`bridge ready (built): ${DEFAULT_BRIDGE_BIN}`);
  return DEFAULT_BRIDGE_BIN;
}

function upsertRuntimeEnvValue(path: string, key: string, value: string) {
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = content ? content.split(/\r?\n/g) : [];
  let updated = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      return line;
    }

    const existingKey = line.slice(0, separatorIndex).trim();
    if (existingKey !== key) {
      return line;
    }

    updated = true;
    return `${key}=${serializeEnvValue(value)}`;
  });

  if (!updated) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${nextLines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
}

function serializeEnvValue(value: string) {
  if (!value) {
    return "";
  }

  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function resolveSwiftCommand() {
  const configuredSwiftBin = process.env.LOBSTER_SWIFT_BIN?.trim();
  if (configuredSwiftBin) {
    return configuredSwiftBin;
  }

  if (existsSync(DEFAULT_SWIFT_BIN)) {
    return DEFAULT_SWIFT_BIN;
  }

  throw new Error(
    "Swift toolchain not found. Install Xcode command line tools and ensure /usr/bin/swift exists, or set LOBSTER_SWIFT_BIN."
  );
}

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: process.env.PATH?.trim() ? process.env.PATH : FALLBACK_PATH
      }
    });

    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}`));
      }
    });
  });
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  prepareBridgeBinary().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

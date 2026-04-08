import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin } from "node:process";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";
import { getBootstrapStatus, runBootstrapWizard } from "./bootstrap.js";

export async function startWithBootstrap() {
  loadRuntimeEnvFile();

  const status = getBootstrapStatus();
  if (!status.isReady) {
    if (!stdin.isTTY) {
      console.error("Lobster bootstrap is not ready:");
      for (const item of status.missing) {
        console.error(`- ${item}`);
      }
      console.error("Run `pnpm --filter lobsterd run init` in an interactive shell first.");
      process.exitCode = 1;
      return;
    }

    console.log("首次启动检测到尚未完成配置，进入 Bootstrap 向导。");
    console.log("");
    try {
      await runBootstrapWizard();
    } catch (error) {
      if (isAbortError(error)) {
        console.log("Bootstrap cancelled.");
        process.exitCode = 130;
        return;
      }
      throw error;
    }
  }

  loadRuntimeEnvFile();
  const { startLobsterd } = await import("../index.js");
  await startLobsterd();
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  startWithBootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ABORT_ERR";
}

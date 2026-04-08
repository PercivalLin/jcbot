import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";
import { getBootstrapStatus } from "./bootstrap.js";

export async function startWithBootstrap() {
  loadRuntimeEnvFile();

  const status = getBootstrapStatus();
  if (!status.isReady) {
    console.log("检测到尚未完成初始化，Lobster 将以 setup mode 启动。");
    for (const item of status.missing) {
      console.log(`- ${item}`);
    }
    console.log("打开本地管理面完成配置，或使用 `pnpm --filter lobsterd run init` 进入 CLI 向导。");
    console.log("");
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

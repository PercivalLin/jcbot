import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveWorkspaceConfigFile(params: {
  importMetaUrl: string;
  maxDepth?: number;
  name: string;
  override?: string;
}) {
  const override = params.override?.trim();
  if (override) {
    return override;
  }

  const maxDepth = params.maxDepth ?? 12;
  const importMetaDir = dirname(fileURLToPath(params.importMetaUrl));
  const workspaceRootFromImportMeta = findWorkspaceRoot(importMetaDir, maxDepth);
  const workspaceRootFromCwd = findWorkspaceRoot(process.cwd(), maxDepth);
  const workspaceRoot = workspaceRootFromImportMeta ?? workspaceRootFromCwd;

  if (workspaceRoot) {
    // Keep all runtime config under the monorepo root, even when scripts run
    // with package-level cwd (for example pnpm --filter lobsterd run ...).
    return resolve(workspaceRoot, "config", params.name);
  }

  const cwdCandidate = resolve(process.cwd(), "config", params.name);
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  let current = importMetaDir;
  for (let index = 0; index < maxDepth; index += 1) {
    const candidate = join(current, "config", params.name);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return cwdCandidate;
}

function findWorkspaceRoot(startPath: string, maxDepth: number) {
  let current = resolve(startPath);
  for (let index = 0; index < maxDepth; index += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

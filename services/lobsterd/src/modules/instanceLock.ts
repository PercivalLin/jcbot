import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_INSTANCE_LOCK_PATH = "/tmp/lobster/lobsterd.lock";

type InstanceLockRecord = {
  pid: number;
  startedAt?: string;
};

type AcquireInstanceLockOptions = {
  lockPath?: string;
  pid?: number;
};

export type InstanceLockHandle = {
  lockPath: string;
  pid: number;
  release: () => void;
};

export function resolveInstanceLockPath() {
  const configured = process.env.LOBSTER_INSTANCE_LOCK_PATH?.trim();
  if (configured) {
    return configured;
  }
  return DEFAULT_INSTANCE_LOCK_PATH;
}

export function acquireInstanceLock(options: AcquireInstanceLockOptions = {}): InstanceLockHandle {
  const lockPath = options.lockPath?.trim() || resolveInstanceLockPath();
  const pid = options.pid ?? process.pid;
  const payload = JSON.stringify({
    pid,
    startedAt: new Date().toISOString()
  });

  mkdirSync(dirname(lockPath), { recursive: true });

  const createLockFile = () => {
    writeFileSync(lockPath, payload, {
      encoding: "utf8",
      flag: "wx"
    });
  };

  try {
    createLockFile();
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }

    const existing = readLockRecord(lockPath);
    if (existing?.pid && isProcessAlive(existing.pid)) {
      throw new Error(
        `Another lobsterd instance is already running (pid=${existing.pid}). Lock file: ${lockPath}`
      );
    }

    rmSync(lockPath, { force: true });
    try {
      createLockFile();
    } catch (retryError) {
      if (!isFileExistsError(retryError)) {
        throw retryError;
      }

      const retryExisting = readLockRecord(lockPath);
      const pidHint = retryExisting?.pid ? ` (pid=${retryExisting.pid})` : "";
      throw new Error(`Failed to acquire lobsterd instance lock${pidHint}. Lock file: ${lockPath}`);
    }
  }

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    releaseLockIfOwned(lockPath, pid);
  };

  return {
    lockPath,
    pid,
    release
  };
}

function releaseLockIfOwned(lockPath: string, pid: number) {
  const existing = readLockRecord(lockPath);
  if (existing && existing.pid !== pid) {
    return;
  }
  rmSync(lockPath, { force: true });
}

function readLockRecord(lockPath: string): InstanceLockRecord | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as {
        pid?: unknown;
        startedAt?: unknown;
      };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        return {
          pid: parsed.pid,
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined
        };
      }
    } catch {
      // Backward compatibility for plain numeric lock file content.
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return { pid };
      }
    }

    return undefined;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error)) {
      if (error.code === "EPERM") {
        return true;
      }
      if (error.code === "ESRCH") {
        return false;
      }
    }
    return false;
  }
}

function isFileExistsError(error: unknown) {
  return isNodeError(error) && error.code === "EEXIST";
}

function isFileNotFoundError(error: unknown) {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock } from "./instanceLock.js";

describe("instanceLock", () => {
  it("acquires and releases lock file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-instance-lock-"));
    const lockPath = join(dir, "lobsterd.lock");

    const lock = acquireInstanceLock({
      lockPath,
      pid: process.pid
    });

    expect(existsSync(lockPath)).toBe(true);

    lock.release();

    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects second acquisition while lock owner is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-instance-lock-busy-"));
    const lockPath = join(dir, "lobsterd.lock");

    const lock = acquireInstanceLock({
      lockPath,
      pid: process.pid
    });

    expect(() =>
      acquireInstanceLock({
        lockPath,
        pid: process.pid
      })
    ).toThrow(/already running/i);

    lock.release();
  });

  it("replaces stale lock file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-instance-lock-stale-"));
    const lockPath = join(dir, "lobsterd.lock");

    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

    const lock = acquireInstanceLock({
      lockPath,
      pid: process.pid
    });

    expect(existsSync(lockPath)).toBe(true);

    lock.release();
  });
});

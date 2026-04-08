import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { TaskRun } from "@lobster/shared";
import { createRuntimePersistence } from "./index.js";

describe("createRuntimePersistence", () => {
  it("falls back to JSON persistence when SQLite cannot be loaded", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-storage-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const run: TaskRun = {
      runId: "run-1",
      request: {
        id: "task-1",
        source: "system",
        userId: "tester",
        text: "Open Finder",
        attachments: [],
        riskPreference: "auto",
        createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString()
      },
      status: "completed",
      riskLevel: "green",
      plan: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      updatedAt: new Date("2026-01-01T00:01:00.000Z").toISOString()
    };

    await persistence.saveRun(run);
    await persistence.setRuntimeValue("telegram.offset.test", "42");
    const runs = await persistence.listRuns();
    const offset = await persistence.getRuntimeValue("telegram.offset.test");

    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-1");
    expect(offset).toBe("42");
    expect(["sqlite", "json-file"]).toContain(persistence.backend);

    rmSync(runtimeDir, { recursive: true, force: true });
  });
});

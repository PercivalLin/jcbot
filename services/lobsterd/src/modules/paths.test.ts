import { describe, expect, it } from "vitest";
import { resolveWorkspaceConfigFile } from "./paths.js";

describe("resolveWorkspaceConfigFile", () => {
  it("returns override when provided", () => {
    const resolved = resolveWorkspaceConfigFile({
      importMetaUrl: import.meta.url,
      name: "models.yaml",
      override: "/tmp/custom-models.yaml"
    });
    expect(resolved).toBe("/tmp/custom-models.yaml");
  });

  it("finds workspace config by walking upward", () => {
    const resolved = resolveWorkspaceConfigFile({
      importMetaUrl: import.meta.url,
      name: "models.yaml"
    });
    expect(resolved.endsWith("/config/models.yaml")).toBe(true);
  });
});

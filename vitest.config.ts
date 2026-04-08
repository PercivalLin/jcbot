import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@lobster/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@lobster/policy": resolve(__dirname, "packages/policy/src/index.ts"),
      "@lobster/storage": resolve(__dirname, "packages/storage/src/index.ts"),
      "@lobster/skills": resolve(__dirname, "packages/skills/src/index.ts")
    }
  },
  test: {
    exclude: [...configDefaults.exclude, "**/._*"]
  }
});

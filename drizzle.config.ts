import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/storage/src/schema.ts",
  out: "./packages/storage/drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./artifacts/lobster.db"
  }
});


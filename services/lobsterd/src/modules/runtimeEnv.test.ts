import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeEnvFile, parseEnvFile } from "./runtimeEnv.js";

describe("parseEnvFile", () => {
  it("parses plain, single-quoted, and double-quoted env values", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "FOO=bar",
        "EMPTY=",
        "SINGLE='hello world'",
        'DOUBLE="line1\\nline2"',
        "NO_SEP",
        ""
      ].join("\n")
    );

    expect(parsed).toEqual([
      { key: "FOO", value: "bar" },
      { key: "EMPTY", value: "" },
      { key: "SINGLE", value: "hello world" },
      { key: "DOUBLE", value: "line1\nline2" }
    ]);
  });

  it("recovers old miswired sk key names into OPENAI_COMPATIBLE_API_KEY", () => {
    const key = "sk-1234567890abcdefghijklmnop";
    const dir = mkdtempSync(join(tmpdir(), "lobster-runtime-env-"));
    const envPath = join(dir, "runtime.env");
    writeFileSync(envPath, `${key}=\n`, "utf8");

    const previousCompat = process.env.OPENAI_COMPATIBLE_API_KEY;
    const previousOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const loaded = loadRuntimeEnvFile(envPath);

    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBe(key);
    expect(loaded.loaded).toContainEqual({ key: "OPENAI_COMPATIBLE_API_KEY", value: key });
    expect(loaded.loaded.find((entry) => entry.key.startsWith("sk-"))).toBeUndefined();

    if (previousCompat === undefined) {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_API_KEY = previousCompat;
    }
    if (previousOpenAI === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAI;
    }
  });

  it("loads secrets from *_FILE entries using runtime.env-relative paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-runtime-env-file-"));
    const secretDir = join(dir, "secrets");
    const envPath = join(dir, "runtime.env");
    const keyFile = join(secretDir, "openai.key");
    const tokenFile = join(secretDir, "telegram.token");

    mkdirSync(secretDir, { recursive: true });
    writeFileSync(keyFile, "key-from-file\n", { encoding: "utf8", flag: "w" });
    writeFileSync(tokenFile, "token-from-file\n", { encoding: "utf8", flag: "w" });
    writeFileSync(
      envPath,
      [
        "OPENAI_COMPATIBLE_API_KEY_FILE=secrets/openai.key",
        "LOBSTER_TELEGRAM_BOT_TOKEN_FILE=secrets/telegram.token"
      ].join("\n"),
      "utf8"
    );

    const previousKey = process.env.OPENAI_COMPATIBLE_API_KEY;
    const previousToken = process.env.LOBSTER_TELEGRAM_BOT_TOKEN;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.LOBSTER_TELEGRAM_BOT_TOKEN;

    loadRuntimeEnvFile(envPath);

    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBe("key-from-file");
    expect(process.env.LOBSTER_TELEGRAM_BOT_TOKEN).toBe("token-from-file");

    if (previousKey === undefined) {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_API_KEY = previousKey;
    }
    if (previousToken === undefined) {
      delete process.env.LOBSTER_TELEGRAM_BOT_TOKEN;
    } else {
      process.env.LOBSTER_TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("keeps explicit env values over *_FILE entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-runtime-env-explicit-"));
    const secretDir = join(dir, "secrets");
    const envPath = join(dir, "runtime.env");
    const keyFile = join(secretDir, "openai.key");

    mkdirSync(secretDir, { recursive: true });
    writeFileSync(keyFile, "key-from-file\n", { encoding: "utf8", flag: "w" });
    writeFileSync(envPath, "OPENAI_COMPATIBLE_API_KEY_FILE=secrets/openai.key\n", "utf8");

    const previousKey = process.env.OPENAI_COMPATIBLE_API_KEY;
    process.env.OPENAI_COMPATIBLE_API_KEY = "key-from-env";

    loadRuntimeEnvFile(envPath);

    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBe("key-from-env");

    if (previousKey === undefined) {
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_API_KEY = previousKey;
    }
  });

  it("resolves NODE_EXTRA_CA_CERTS relative path against runtime.env location", () => {
    const dir = mkdtempSync(join(tmpdir(), "lobster-runtime-env-cert-path-"));
    const certDir = join(dir, "certs");
    const envPath = join(dir, "runtime.env");
    const certPath = join(certDir, "proxy-ca.pem");

    mkdirSync(certDir, { recursive: true });
    writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n", "utf8");
    writeFileSync(envPath, "NODE_EXTRA_CA_CERTS=certs/proxy-ca.pem\n", "utf8");

    const previous = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;

    loadRuntimeEnvFile(envPath);

    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(certPath);

    if (previous === undefined) {
      delete process.env.NODE_EXTRA_CA_CERTS;
    } else {
      process.env.NODE_EXTRA_CA_CERTS = previous;
    }
  });
});

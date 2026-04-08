import { describe, expect, it } from "vitest";
import {
  formatNetworkError,
  inferTelegramTroubleshootingHint,
  validateTelegramBaseUrl
} from "./telegramDiagnostics.js";

describe("telegramDiagnostics", () => {
  it("detects invalid base URL path that already includes bot token path", () => {
    const issue = validateTelegramBaseUrl("https://api.telegram.org/bot123456:abcdef");
    expect(issue).toContain("should not include");
  });

  it("formats network errors with code and host from cause", () => {
    const error = new Error("fetch failed", {
      cause: {
        code: "ENOTFOUND",
        hostname: "api.telegram.org"
      }
    });
    const formatted = formatNetworkError(error);
    expect(formatted).toContain("ENOTFOUND");
    expect(formatted).toContain("api.telegram.org");
  });

  it("generates DNS troubleshooting hint for ENOTFOUND", () => {
    const hint = inferTelegramTroubleshootingHint(
      "fetch failed (code=ENOTFOUND, host=api.telegram.org)",
      "https://api.telegram.org"
    );
    expect(hint).toContain("DNS");
  });

  it("generates timeout hint for aborted requests", () => {
    const hint = inferTelegramTroubleshootingHint(
      "This operation was aborted",
      "https://api.telegram.org"
    );
    expect(hint).toContain("timed out");
  });

  it("generates tls hint for SSL errors", () => {
    const hint = inferTelegramTroubleshootingHint(
      "telegram curl request failed (exit=35): curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL",
      "https://api.telegram.org"
    );
    expect(hint).toContain("TLS");
  });
});

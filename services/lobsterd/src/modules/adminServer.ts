import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent, TaskRun } from "@lobster/shared";
import type { ModelProfile } from "@lobster/shared";
import type { RpcServer } from "../ipc/rpcServer.js";
import {
  readAdminConfigSnapshot,
  updateModelConfig,
  updateRuntimeConfig,
  updateSecrets,
  type AdminConfigSnapshot,
  type AdminRuntimeConfig
} from "./adminConfig.js";
import type { RuntimeReadinessReport } from "./runtimeReadiness.js";
import type { BridgeCapabilities } from "./bridgeClient.js";

type AdminServerOptions = {
  bridgeCapabilitiesProvider?: () => Promise<BridgeCapabilities | undefined> | BridgeCapabilities | undefined;
  csrfToken: string;
  onModelsUpdated?: (profiles: Record<ModelProfile["role"], ModelProfile>) => Promise<void> | void;
  onRuntimeConfigUpdated?: (snapshot: AdminConfigSnapshot) => Promise<void> | void;
  rpcServer: RpcServer;
  runtimeReadinessProvider: () => Promise<RuntimeReadinessReport> | RuntimeReadinessReport;
};

type SsePayload = {
  data: unknown;
  event: string;
};

const ADMIN_WEB_DIST = resolve(
  fileURLToPath(new URL("../../../../apps/admin-web/dist", import.meta.url))
);

export class AdminServer {
  private readonly clients = new Set<ServerResponse>();
  private server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });

  constructor(private readonly port: number, private readonly options: AdminServerOptions) {}

  start() {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(this.port, "127.0.0.1", () => resolvePromise());
    });
  }

  async close() {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();

    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    });
  }

  publish(payload: SsePayload) {
    const data = `event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`;
    for (const client of this.clients) {
      client.write(data);
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/admin/stream" && method === "GET") {
      this.handleSse(response);
      return;
    }

    if (url.pathname === "/api/admin/readiness" && method === "GET") {
      return this.sendJson(response, 200, await this.options.runtimeReadinessProvider());
    }

    if (url.pathname === "/api/admin/runtime" && method === "GET") {
      const [readiness, runs, approvals, bridgeCapabilities] = await Promise.all([
        this.options.runtimeReadinessProvider(),
        this.options.rpcServer.listRuns(),
        this.options.rpcServer.listApprovals(),
        this.options.bridgeCapabilitiesProvider?.()
      ]);
      const currentRun = runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
      return this.sendJson(response, 200, {
        bridge: {
          healthy: Boolean(bridgeCapabilities),
          permissions: summarizeBridgePermissions(bridgeCapabilities),
          protocolVersion: bridgeCapabilities?.protocolVersion ?? "legacy",
          status: bridgeCapabilities ? "connected" : "unavailable"
        },
        currentRun: currentRun ? serializeRun(currentRun) : null,
        csrfToken: this.options.csrfToken,
        now: new Date().toISOString(),
        pendingApprovals: approvals.filter((approval) => approval.state === "pending").length,
        port: this.port,
        runtime: {
          readinessSummary: readiness.summary
        }
      });
    }

    if (url.pathname === "/api/admin/config" && method === "GET") {
      return this.sendJson(response, 200, readAdminConfigSnapshot());
    }

    if (url.pathname === "/api/admin/config/runtime" && method === "PUT") {
      if (!this.assertCsrf(request, response)) {
        return;
      }
      const body = await this.readJsonBody<Partial<AdminRuntimeConfig>>(request);
      const snapshot = updateRuntimeConfig(body);
      await this.options.onRuntimeConfigUpdated?.(snapshot);
      this.publish({ event: "config.updated", data: snapshot });
      return this.sendJson(response, 200, snapshot);
    }

    if (url.pathname === "/api/admin/config/models" && method === "PUT") {
      if (!this.assertCsrf(request, response)) {
        return;
      }
      const body = await this.readJsonBody<unknown>(request);
      const snapshot = updateModelConfig(body);
      await this.options.onModelsUpdated?.(snapshot.models);
      this.publish({ event: "config.updated", data: snapshot });
      return this.sendJson(response, 200, snapshot);
    }

    if (url.pathname === "/api/admin/config/secrets" && method === "PUT") {
      if (!this.assertCsrf(request, response)) {
        return;
      }
      const body = await this.readJsonBody<{ openaiCompatibleApiKey?: string; telegramBotToken?: string }>(request);
      const snapshot = updateSecrets(body);
      await this.options.onRuntimeConfigUpdated?.(snapshot);
      this.publish({ event: "config.updated", data: snapshot });
      return this.sendJson(response, 200, snapshot);
    }

    if (url.pathname === "/api/admin/runs" && method === "GET") {
      const runs = await this.options.rpcServer.listRuns();
      return this.sendJson(response, 200, runs.map((run) => serializeRun(run)));
    }

    if (url.pathname === "/api/admin/approvals" && method === "GET") {
      return this.sendJson(response, 200, await this.options.rpcServer.listApprovals());
    }

    const runMatch = url.pathname.match(/^\/api\/admin\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") {
      const run = await this.options.rpcServer.getRun(runMatch[1] ?? "");
      if (!run) {
        return this.sendJson(response, 404, { error: "Run not found" });
      }
      return this.sendJson(response, 200, serializeRun(run));
    }

    const runEventsMatch = url.pathname.match(/^\/api\/admin\/runs\/([^/]+)\/events$/);
    if (runEventsMatch && method === "GET") {
      const events = await this.options.rpcServer.listRunEvents(runEventsMatch[1] ?? "");
      return this.sendJson(response, 200, events.map((event) => serializeRunEvent(event)));
    }

    const runScreenshotMatch = url.pathname.match(/^\/api\/admin\/runs\/([^/]+)\/screenshot$/);
    if (runScreenshotMatch && method === "GET") {
      const run = await this.options.rpcServer.getRun(runScreenshotMatch[1] ?? "");
      if (!run) {
        return this.sendJson(response, 404, { error: "Run not found" });
      }

      const screenshotPath = run.latestObservation?.screenshotPath?.trim();
      if (!screenshotPath) {
        return this.sendJson(response, 404, { error: "Screenshot not available for this run" });
      }

      if (!existsSync(screenshotPath)) {
        return this.sendJson(response, 404, { error: "Screenshot file is no longer available" });
      }

      return this.sendFile(response, screenshotPath, { "Cache-Control": "no-store" });
    }

    if (method === "GET") {
      return this.serveStatic(url.pathname, response);
    }

    this.sendJson(response, 404, { error: "Not found" });
  }

  private handleSse(response: ServerResponse) {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
    this.clients.add(response);
    response.on("close", () => {
      this.clients.delete(response);
    });
  }

  private assertCsrf(request: IncomingMessage, response: ServerResponse) {
    const token = request.headers["x-lobster-csrf"];
    if (token !== this.options.csrfToken) {
      this.sendJson(response, 403, { error: "Invalid CSRF token" });
      return false;
    }
    return true;
  }

  private async readJsonBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private serveStatic(pathname: string, response: ServerResponse) {
    if (!existsSync(ADMIN_WEB_DIST)) {
      return this.sendJson(response, 503, {
        error: "admin-web build is not available",
        hint: "Run pnpm --filter lobster-admin-web build."
      });
    }

    const safePath = pathname === "/" ? "/index.html" : pathname;
    const target = normalize(join(ADMIN_WEB_DIST, safePath));
    if (!target.startsWith(ADMIN_WEB_DIST) || !existsSync(target)) {
      const fallback = join(ADMIN_WEB_DIST, "index.html");
      return this.sendFile(response, fallback);
    }
    return this.sendFile(response, target);
  }

  private sendFile(response: ServerResponse, path: string, headers?: Record<string, string>) {
    const contentType = contentTypeFor(extname(path));
    response.writeHead(200, { "Content-Type": contentType, ...(headers ?? {}) });
    response.end(readFileSync(path));
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }
}

function contentTypeFor(extension: string) {
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "text/plain; charset=utf-8";
  }
}

const ACTIVE_RUN_STATUSES = new Set<TaskRun["status"]>([
  "queued",
  "context_build",
  "planned",
  "self_checked",
  "awaiting_approval",
  "executing",
  "verifying"
]);

function serializeRun(run: TaskRun) {
  const currentStepIndex = run.currentStepId ? run.plan.findIndex((step) => step.id === run.currentStepId) + 1 : 0;
  const latestObservation = run.latestObservation
      ? {
        observationId: run.latestObservation.observationId,
        activeApp: run.latestObservation.activeApp,
        activeWindowTitle: run.latestObservation.activeWindowTitle,
        candidatePreview: run.latestObservation.candidates.slice(0, 8).map((candidate) => ({
          id: candidate.id,
          role: candidate.role,
          label: candidate.label,
          value: candidate.value,
          focused: candidate.focused,
          confidence: candidate.confidence,
          source: candidate.source
        })),
        focusedElement: run.latestObservation.focusedElement
          ? {
              id: run.latestObservation.focusedElement.id,
              role: run.latestObservation.focusedElement.role,
              label: run.latestObservation.focusedElement.label,
              value: run.latestObservation.focusedElement.value,
              focused: run.latestObservation.focusedElement.focused,
              confidence: run.latestObservation.focusedElement.confidence,
              source: run.latestObservation.focusedElement.source
            }
          : undefined,
        observationMode: run.latestObservation.observationMode,
        ocrText: run.latestObservation.ocrText.slice(0, 24),
        recentEvents: (run.latestObservation.recentEvents ?? []).slice(-6),
        screenshotRef: run.latestObservation.screenshotRef,
        screenshotUrl: run.latestObservation.screenshotPath
          ? `/api/admin/runs/${encodeURIComponent(run.runId)}/screenshot`
          : undefined,
        snapshotAt: run.latestObservation.snapshotAt
      }
    : undefined;

  return {
    id: run.runId,
    source: run.request.source,
    text: run.request.text,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: run.outcomeSummary,
    result: run.outcomeSummary,
    verification: run.verification
      ? {
          status: run.verification.status,
          message: run.verification.message,
          evidence: run.verification.evidence,
          evidenceItems: run.verification.evidenceItems
        }
      : undefined,
    latestObservation,
    currentStepIndex: currentStepIndex > 0 ? currentStepIndex : undefined,
    totalSteps: run.plan.length,
    waitingForApproval: run.status === "awaiting_approval"
  };
}

function serializeRunEvent(event: RunEvent) {
  return {
    id: event.eventId,
    runId: event.runId,
    kind: event.kind,
    createdAt: event.createdAt,
    message: event.message,
    status: event.status,
    metadata: event.stepId ? { stepId: event.stepId } : undefined
  };
}

function summarizeBridgePermissions(bridgeCapabilities: BridgeCapabilities | undefined) {
  if (!bridgeCapabilities) {
    return [];
  }

  return [
    bridgeCapabilities.accessibility ? "accessibility" : undefined,
    bridgeCapabilities.eventTap ? "eventTap" : undefined,
    bridgeCapabilities.screenCapture ? "screenCapture" : undefined,
    bridgeCapabilities.ocr ? "ocr" : undefined
  ].filter((entry): entry is string => Boolean(entry));
}

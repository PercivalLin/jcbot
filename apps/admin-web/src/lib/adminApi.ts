export type AdminReadinessReport = {
  checks: Array<{
    id: string;
    level: "ok" | "warn" | "fail";
    message: string;
    suggestion?: string;
  }>;
  generatedAt?: string;
  summary?: {
    ok: number;
    warn: number;
    fail: number;
  };
};

export type AdminRuntimeStatus = {
  bridge?: {
    status?: string;
    healthy?: boolean;
    protocolVersion?: string | number;
    permissions?: string[];
  };
  csrfToken?: string;
  runtime?: Record<string, unknown>;
  currentRun?: AdminRun | null;
  now?: string;
  pendingApprovals?: number;
  port?: number;
};

export type AdminConfigSnapshot = {
  runtime?: Record<string, unknown>;
  models?: string | Record<string, unknown>;
  secrets?: {
    telegramBotTokenConfigured?: boolean;
    openaiCompatibleApiKeyConfigured?: boolean;
  };
  paths?: Record<string, string>;
};

export type AdminObservationElement = {
  id: string;
  role: string;
  label: string;
  value?: string;
  focused?: boolean;
  confidence?: number;
  source?: "ax" | "ocr" | "vision" | "dom";
};

export type AdminObservationEvent = {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
};

export type AdminRun = {
  id: string;
  source?: string;
  text?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  summary?: string;
  result?: string;
  currentStepIndex?: number;
  totalSteps?: number;
  waitingForApproval?: boolean;
  verification?: {
    status?: "verified" | "dispatched_unverified" | "failed";
    message?: string;
    evidence?: string[];
    evidenceItems?: Array<{
      source?: "local" | "ocr" | "vision" | "bridge" | "event";
      kind?: string;
      message?: string;
      confidence?: number;
      screenshotRef?: string;
      field?: string;
      value?: string;
    }>;
  };
  latestObservation?: {
    activeApp?: string;
    activeWindowTitle?: string;
    candidatePreview?: AdminObservationElement[];
    focusedElement?: AdminObservationElement;
    observationMode?: "accessibility" | "visual" | "hybrid" | "stub";
    ocrText?: string[];
    recentEvents?: AdminObservationEvent[];
    screenshotRef?: string;
    screenshotUrl?: string;
    snapshotAt?: string;
  };
};

export type AdminRunEvent = {
  id: string;
  runId: string;
  kind: string;
  createdAt: string;
  message?: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

export type AdminStreamEvent = {
  event: string;
  data: unknown;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
let cachedCsrfToken: string | undefined;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function getCsrfToken() {
  if (cachedCsrfToken) {
    return cachedCsrfToken;
  }

  const runtime = await request<AdminRuntimeStatus>("/api/admin/runtime");
  cachedCsrfToken = runtime.csrfToken;
  return cachedCsrfToken;
}

async function putJson<T>(path: string, payload: JsonValue | Record<string, unknown>): Promise<T> {
  const csrfToken = await getCsrfToken();
  return request<T>(path, {
    method: "PUT",
    body: JSON.stringify(payload),
    headers: csrfToken ? { "x-lobster-csrf": csrfToken } : undefined
  });
}

export const adminApi = {
  getReadiness: () => request<AdminReadinessReport>("/api/admin/readiness"),
  getRuntime: () => request<AdminRuntimeStatus>("/api/admin/runtime"),
  getConfig: () => request<AdminConfigSnapshot>("/api/admin/config"),
  listRuns: () => request<AdminRun[]>("/api/admin/runs"),
  getRun: (runId: string) => request<AdminRun>(`/api/admin/runs/${encodeURIComponent(runId)}`),
  getRunEvents: (runId: string) =>
    request<AdminRunEvent[]>(`/api/admin/runs/${encodeURIComponent(runId)}/events`),
  updateRuntimeConfig: (runtime: Record<string, unknown>) =>
    putJson<AdminConfigSnapshot>("/api/admin/config/runtime", runtime),
  updateModelsConfig: (raw: string) => putJson<AdminConfigSnapshot>("/api/admin/config/models", { raw }),
  updateSecrets: (payload: { telegramBotToken?: string; openaiCompatibleApiKey?: string }) =>
    putJson<AdminConfigSnapshot>("/api/admin/config/secrets", payload)
};

export function subscribeToAdminStream(onEvent: (event: AdminStreamEvent) => void): () => void {
  const source = new EventSource("/api/admin/stream");
  const forward = (eventName: string, payload: unknown) => {
    onEvent({
      event: eventName,
      data: payload
    });
  };

  const namedEvents = ["ready", "run.event", "approval.updated", "readiness.updated", "bridge.updated", "config.updated"];

  source.onmessage = (message) => {
    try {
      forward("message", JSON.parse(message.data) as unknown);
    } catch {
      forward("message", message.data);
    }
  };

  for (const eventName of namedEvents) {
    source.addEventListener(eventName, (message) => {
      if (!(message instanceof MessageEvent)) {
        return;
      }

      try {
        forward(eventName, JSON.parse(message.data) as unknown);
      } catch {
        forward(eventName, message.data);
      }
    });
  }

  return () => {
    source.close();
  };
}

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ApprovalToken, DesktopAction, DesktopObservation } from "@lobster/shared";
import { isApprovalTokenValid } from "@lobster/policy";
import { getKnownApplications, matchKnownApplication, resolveApplicationAlias } from "@lobster/skills";

type BridgeJsonRpcResponse = {
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export type BridgeCapabilities = {
  accessibility: boolean;
  eventTap: boolean;
  ocr: boolean;
  observationModes?: Array<"accessibility" | "hybrid" | "stub" | "visual">;
  policyHardGate: boolean;
  protocolVersion?: number;
  screenCapture: boolean;
  supportedActions?: string[];
};

export type BridgeActionResult = {
  status: string;
};

export type BridgeActionContext = {
  approvalToken?: ApprovalToken;
  runId: string;
};

export interface BridgeClient {
  configureKnownApplications(applications: string[]): Promise<void>;
  describeCapabilities(): Promise<BridgeCapabilities>;
  searchApplications(query: string): Promise<string[]>;
  performAction(action: DesktopAction, context: BridgeActionContext): Promise<BridgeActionResult>;
  restart?(options?: { args?: string[]; command?: string }): Promise<void>;
  snapshot(): Promise<DesktopObservation>;
  validateAction(action: DesktopAction, context: BridgeActionContext): Promise<{ allowed: boolean; reason: string }>;
}

export class StubBridgeClient implements BridgeClient {
  private knownApplications = getKnownApplications();
  private observationSequence = 0;
  private recentEventSequence = 0;
  private state: DesktopObservation = {
    observationId: "stub://observation/initial",
    screenshotRef: "stub://snapshot/latest",
    snapshotAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    activeApp: "Lobster Stub Desktop",
    activeWindowTitle: "Discovery Workspace",
    ocrText: ["Stub desktop snapshot"],
    windows: ["Discovery Workspace"],
    recentEvents: [],
    candidates: [
      {
        id: "candidate-open-finder",
        role: "button",
        label: "Finder",
        confidence: 0.82,
        source: "ax"
      },
      {
        id: "candidate-search",
        role: "text field",
        label: "Search",
        value: "",
        focused: false,
        confidence: 0.91,
        source: "ax"
      }
    ]
  };

  async configureKnownApplications(applications: string[]) {
    this.knownApplications = getKnownApplications({ extraApplications: applications });
  }

  async describeCapabilities(): Promise<BridgeCapabilities> {
    return {
      accessibility: true,
      eventTap: true,
      ocr: true,
      observationModes: ["stub"],
      policyHardGate: true,
      protocolVersion: 3,
      screenCapture: true
    };
  }

  async searchApplications(query: string): Promise<string[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [...this.knownApplications].slice(0, 8);
    }

    const scored = this.knownApplications
      .map((application) => {
        const lower = application.toLowerCase();
        const score = lower === normalized ? 120 : lower.includes(normalized) ? 80 : normalized.includes(lower) ? 60 : 0;
        return { application, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.application.localeCompare(right.application))
      .map((entry) => entry.application);
    return scored.slice(0, 8);
  }

  async performAction(action: DesktopAction, context: BridgeActionContext): Promise<BridgeActionResult> {
    const validation = await this.validateAction(action, context);
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }

    switch (action.kind) {
      case "ui.open_app":
      case "ui.activate_app": {
        const applicationName = this.resolveApplicationName(action);
        this.state.activeApp = applicationName;
        this.state.activeWindowTitle = `${applicationName} Window`;
        this.state.windows = Array.from(new Set([`${applicationName} Window`, ...this.state.windows]));
        this.recordEvent("window.changed", `${action.kind}:${applicationName}`);
        return {
          status: `${action.kind === "ui.open_app" ? "opened" : "activated"}:${applicationName}`
        };
      }
      case "ui.focus_target":
      case "ui.click_target": {
        const label = this.resolveTargetLabel(action);
        if (!label) {
          return { status: "noop:no-target-label" };
        }

        this.focusCandidate(label);
        this.recordEvent("focus.changed", `${action.kind}:${label}`);
        return { status: `${action.kind === "ui.focus_target" ? "focused" : "clicked"}-target:${label}` };
      }
      case "ui.type_into_target": {
        const label = this.resolveTargetLabel(action);
        const text = this.resolveText(action);
        if (!label || !text) {
          return { status: "noop:missing-target-or-text" };
        }

        const candidate = this.focusCandidate(label, "text field");
        candidate.value = text;
        this.recordEvent("value.changed", `${label}:${text.length}`);
        return { status: `typed-into-target:${label}:${text.length}` };
      }
      case "external.select_contact": {
        const applicationName = this.resolveApplicationName(action);
        if (applicationName) {
          this.state.activeApp = applicationName;
        }

        const contact = this.resolveContactName(action);
        if (!contact) {
          return { status: "noop:no-contact" };
        }

        const searchHints = this.resolveHintList(
          typeof action.args.searchLabelHints === "string" ? action.args.searchLabelHints : undefined,
          ["Search", "搜索", "联系人", "Contact"]
        );
        const searchLabel = this.resolveFirstVisibleLabel(searchHints) ?? searchHints[0] ?? "Search";
        const searchField = this.focusCandidate(searchLabel, "text field");
        searchField.value = contact;

        const contactCandidate = this.focusCandidate(contact, "button");
        contactCandidate.value = undefined;
        contactCandidate.focused = true;
        this.state.activeWindowTitle = `${contact} Chat`;
        this.state.windows = Array.from(new Set([`${contact} Chat`, ...this.state.windows]));
        this.recordEvent("selection.changed", `selected-contact:${contact}`);
        return { status: `selected-contact:${contact}` };
      }
      case "external.upload_file": {
        const path =
          (typeof action.args.filePath === "string" && action.args.filePath.trim()) ||
          (typeof action.args.path === "string" && action.args.path.trim()) ||
          (typeof action.args.file === "string" && action.args.file.trim());
        if (!path) {
          return { status: "noop:no-file-path" };
        }

        const fileName = path.split(/[\\/]/).at(-1) ?? path;
        this.state.activeWindowTitle = `${fileName} Selected`;
        this.state.windows = Array.from(new Set([`${fileName} Selected`, ...this.state.windows]));
        this.recordEvent("window.changed", `uploaded-file:${fileName}`);
        return { status: `uploaded-file:${fileName}` };
      }
      case "ui.type_text":
      case "ui.paste_text": {
        const text = this.resolveText(action);
        if (!text) {
          return { status: "noop:no-text" };
        }

        const candidate =
          this.state.candidates.find((entry) => entry.focused) ?? this.focusCandidate(action.target ?? "Current Focus", "text field");
        candidate.value = text;
        candidate.focused = true;
        this.recordEvent("value.changed", `${action.kind}:${text.length}`);
        return { status: `typed:${text.length}` };
      }
      case "ui.edit_existing": {
        const instruction =
          (typeof action.args.instruction === "string" && action.args.instruction.trim()) ||
          (typeof action.args.text === "string" && action.args.text.trim()) ||
          action.target ||
          "edit";
        this.state.activeWindowTitle = `Edited ${instruction}`;
        this.state.windows = Array.from(new Set([`Edited ${instruction}`, ...this.state.windows]));
        this.recordEvent("value.changed", `edited:${instruction}`);
        return { status: `edited:${instruction}` };
      }
      case "ui.hotkey": {
        const keys =
          (typeof action.args.keys === "string" && action.args.keys.trim()) ||
          (typeof action.args.hotkey === "string" && action.args.hotkey.trim()) ||
          "unknown";
        const normalizedKeys = keys.toLowerCase();
        if (normalizedKeys === "cmd+p") {
          const picker = this.focusCandidate("Quick Open", "text field");
          picker.value = "";
          this.state.activeWindowTitle = "Quick Open";
          this.state.windows = Array.from(new Set(["Quick Open", ...this.state.windows]));
        } else if (normalizedKeys === "enter") {
          const focused =
            this.state.candidates.find((candidate) => candidate.focused) ??
            this.focusCandidate(action.target ?? "Current Focus", "text field");
          const destination = focused.value?.trim() || "Confirmed";
          this.state.activeWindowTitle = destination;
          this.state.windows = Array.from(new Set([destination, ...this.state.windows]));
        } else {
          this.state.activeWindowTitle = `Shortcut ${keys}`;
          this.state.windows = Array.from(new Set([`Shortcut ${keys}`, ...this.state.windows]));
        }
        this.recordEvent("window.changed", `hotkey:${keys}`);
        return { status: `hotkey:${keys}` };
      }
      case "ui.scroll": {
        const direction =
          (typeof action.args.direction === "string" && action.args.direction.trim()) ||
          "down";
        const amount =
          (typeof action.args.amount === "string" && action.args.amount.trim()) ||
          "320";
        this.state.activeWindowTitle = `Scrolled ${direction}`;
        this.state.windows = Array.from(new Set([`Scrolled ${direction}`, ...this.state.windows]));
        this.recordEvent("selection.changed", `scroll:${direction}:${amount}`);
        return { status: `scrolled:${direction}:${amount}` };
      }
      default:
        return { status: `stubbed:${action.kind}` };
    }
  }

  async snapshot(): Promise<DesktopObservation> {
    this.observationSequence += 1;
    this.state.observationId = `stub://observation/${this.observationSequence}`;
    this.state.snapshotAt = new Date(Date.UTC(2026, 0, 1, 0, 0, this.observationSequence)).toISOString();
    this.state.screenshotRef = `stub://snapshot/${this.observationSequence}`;
    return {
      ...this.state,
      windows: [...this.state.windows],
      ocrText: [...this.state.ocrText],
      recentEvents: (this.state.recentEvents ?? []).map((event) => ({
        ...event
      })),
      candidates: this.state.candidates.map((candidate) => ({
        ...candidate,
        bounds: candidate.bounds ? { ...candidate.bounds } : undefined
      }))
    };
  }

  async validateAction(action: DesktopAction, context: BridgeActionContext) {
    if (!action.id.trim()) {
      return {
        allowed: false,
        reason: `Stub bridge requires a canonical actionId for ${action.kind}.`
      };
    }

    if (!context.runId.trim()) {
      return {
        allowed: false,
        reason: `Stub bridge requires a canonical runId for ${action.kind}.`
      };
    }

    if (action.riskLevel === "red") {
      return {
        allowed: false,
        reason: `Stub bridge rejected redline action ${action.kind}.`
      };
    }

    if (action.riskLevel === "yellow" && !context.approvalToken) {
      return {
        allowed: false,
        reason: `Stub bridge requires approval for ${action.kind}.`
      };
    }

    if (action.riskLevel === "yellow" && context.approvalToken && context.approvalToken.runId !== context.runId) {
      return {
        allowed: false,
        reason: `Stub bridge rejected approval token with mismatched runId for ${action.kind}.`
      };
    }

    if (action.riskLevel === "yellow" && context.approvalToken && !isApprovalTokenValid(context.approvalToken, action)) {
      return {
        allowed: false,
        reason: `Stub bridge rejected stale or mismatched approval token for ${action.kind}.`
      };
    }

    return {
      allowed: true,
      reason: "Action allowed by stub bridge."
    };
  }

  async restart() {}

  private recordEvent(kind: string, message: string) {
    this.recentEventSequence += 1;
    const event = {
      id: `stub-event-${this.recentEventSequence}`,
      kind,
      message,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.recentEventSequence)).toISOString(),
      sequence: this.recentEventSequence
    };
    const recentEvents = [...(this.state.recentEvents ?? []), event];
    this.state.recentEvents = recentEvents.slice(-18);
  }

  private resolveApplicationName(action: DesktopAction) {
    const directTarget =
      (typeof action.args.app === "string" && action.args.app.trim()) ||
      action.target?.trim() ||
      "";
    if (directTarget && directTarget !== "discovery" && directTarget !== "pending-target" && directTarget !== "pending-contact") {
      return resolveApplicationAlias(directTarget);
    }

    const freeText = [
      typeof action.args.application === "string" ? action.args.application : undefined,
      typeof action.args.text === "string" ? action.args.text : undefined,
      action.target
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");

    return matchKnownApplication(freeText, { extraApplications: this.knownApplications }) ?? this.state.activeApp;
  }

  private resolveTargetLabel(action: DesktopAction) {
    const candidates = [
      typeof action.args.label === "string" ? action.args.label : undefined,
      typeof action.args.targetLabel === "string" ? action.args.targetLabel : undefined,
      action.target
    ];

    return candidates.find((value) => value && value.trim().length > 0)?.trim();
  }

  private resolveText(action: DesktopAction) {
    const candidates = [
      typeof action.args.text === "string" ? action.args.text : undefined,
      typeof action.args.value === "string" ? action.args.value : undefined,
      typeof action.args.message === "string" ? action.args.message : undefined
    ];

    return candidates.find((value) => value && value.trim().length > 0)?.trim();
  }

  private resolveContactName(action: DesktopAction) {
    const placeholders = new Set(["pending-contact", "pending-target", "discovery", "active-window"]);
    const candidates = [
      typeof action.args.contact === "string" ? action.args.contact : undefined,
      typeof action.args.targetContact === "string" ? action.args.targetContact : undefined,
      action.target
    ];

    for (const candidate of candidates) {
      const normalized = candidate?.trim();
      if (!normalized) {
        continue;
      }
      if (placeholders.has(normalized.toLowerCase())) {
        continue;
      }
      return normalized;
    }

    return undefined;
  }

  private resolveHintList(raw: string | undefined, fallback: string[]) {
    const parsed = (raw ?? "")
      .split(/[;,|/]/g)
      .map((value) => value.trim())
      .filter(Boolean);
    return parsed.length > 0 ? Array.from(new Set(parsed)) : [...fallback];
  }

  private resolveFirstVisibleLabel(hints: string[]) {
    for (const hint of hints) {
      const normalizedHint = hint.trim().toLowerCase();
      const matched = this.state.candidates.find((candidate) => {
        const label = candidate.label.trim().toLowerCase();
        return label === normalizedHint || label.includes(normalizedHint) || normalizedHint.includes(label);
      });
      if (matched?.label) {
        return matched.label;
      }
    }

    return undefined;
  }

  private focusCandidate(label: string, role = "button") {
    const normalizedLabel = label.trim().toLowerCase();
    const existing =
      this.state.candidates.find((candidate) => candidate.label.trim().toLowerCase() === normalizedLabel) ??
      this.state.candidates.find((candidate) => candidate.label.trim().toLowerCase().includes(normalizedLabel));

    for (const candidate of this.state.candidates) {
      candidate.focused = false;
    }

    if (existing) {
      existing.focused = true;
      return existing;
    }

    const created = {
      id: `candidate-${randomUUID()}`,
      role,
      label,
      value: role === "text field" ? "" : undefined,
      focused: true,
      confidence: 0.75,
      source: "ax" as const
    };
    this.state.candidates.push(created);
    return created;
  }
}

export class ChildProcessBridgeClient implements BridgeClient {
  private process?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private stdoutReader?: ReturnType<typeof createInterface>;
  private readonly pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private command: string, private args: string[] = []) {}

  async configureKnownApplications(applications: string[]) {
    await this.request("bridge.configureKnownApplications", {
      appsJson: JSON.stringify(applications)
    }, 10_000);
  }

  async describeCapabilities() {
    const result = (await this.request("bridge.describeCapabilities", undefined, 10_000)) as Partial<BridgeCapabilities>;
    return {
      accessibility: Boolean(result.accessibility),
      eventTap: Boolean(result.eventTap),
      ocr: Boolean(result.ocr),
      observationModes: result.observationModes ?? ["accessibility"],
      policyHardGate: result.policyHardGate !== false,
      protocolVersion: result.protocolVersion ?? 1,
      screenCapture: Boolean(result.screenCapture),
      supportedActions: result.supportedActions ?? []
    };
  }

  async searchApplications(query: string) {
    return (await this.request("bridge.searchApplications", {
      query
    }, 10_000)) as string[];
  }

  async performAction(action: DesktopAction, context: BridgeActionContext) {
    return (await this.request("ui.performAction", {
      actionId: action.id,
      actionKind: action.kind,
      approvalTokenJson: context.approvalToken ? JSON.stringify(context.approvalToken) : "",
      runId: context.runId,
      target: action.target ?? "",
      text: typeof action.args.text === "string" ? action.args.text : "",
      argsJson: JSON.stringify(action.args ?? {}),
      targetDescriptorJson: action.targetDescriptor ? JSON.stringify(action.targetDescriptor) : ""
    }, 30_000)) as BridgeActionResult;
  }

  async snapshot(): Promise<DesktopObservation> {
    const result = (await this.request("observation.snapshot", undefined, 15_000)) as {
      activeApp?: string;
      activeWindowTitle?: string;
      observationId?: string;
      candidates?: Array<{
        bounds?: {
          height: number;
          width: number;
          x: number;
          y: number;
        };
        confidence?: number;
        focused?: boolean;
        id?: string;
        label?: string;
        role?: string;
        source?: "ax" | "ocr" | "vision" | "dom";
        value?: string;
      }>;
      focusedElement?: {
        bounds?: {
          height: number;
          width: number;
          x: number;
          y: number;
        };
        confidence?: number;
        focused?: boolean;
        id?: string;
        label?: string;
        role?: string;
        source?: "ax" | "ocr" | "vision" | "dom";
        value?: string;
      };
      note?: string;
      ocrText?: string[];
      observationMode?: "accessibility" | "hybrid" | "stub" | "visual";
      recentEvents?: Array<{
        createdAt?: string;
        id?: string;
        kind?: string;
        message?: string;
        sequence?: number;
      }>;
      screenshotRef?: string;
      screenshotPath?: string;
      snapshotAt?: string;
      windows?: string[];
    };
    const normalizeCandidate = (candidate: {
      bounds?: {
        height: number;
        width: number;
        x: number;
        y: number;
      };
      confidence?: number;
      focused?: boolean;
      id?: string;
      label?: string;
      role?: string;
      source?: "ax" | "ocr" | "vision" | "dom";
      value?: string;
    }) => ({
      id: candidate.id ?? randomUUID(),
      role: candidate.role ?? "Unknown",
      label: candidate.label ?? "",
      value: typeof candidate.value === "string" ? candidate.value : undefined,
      focused: typeof candidate.focused === "boolean" ? candidate.focused : undefined,
      bounds: candidate.bounds,
      confidence: candidate.confidence ?? 0.5,
      source: candidate.source ?? "ax"
    });

    return {
      observationId: result.observationId,
      screenshotRef: result.screenshotRef ?? "bridge://unknown",
      activeApp: result.activeApp ?? "Unknown",
      activeWindowTitle: result.activeWindowTitle ?? result.note,
      ocrText: result.ocrText ?? (result.note ? [result.note] : []),
      snapshotAt: result.snapshotAt ?? new Date().toISOString(),
      screenshotPath: result.screenshotPath,
      observationMode: result.observationMode ?? "accessibility",
      focusedElement: result.focusedElement ? normalizeCandidate(result.focusedElement) : undefined,
      recentEvents:
        result.recentEvents?.map((event) => ({
          id: event.id ?? randomUUID(),
          kind: event.kind ?? "bridge.event",
          message: event.message ?? "",
          createdAt: event.createdAt ?? new Date().toISOString(),
          sequence:
            typeof event.sequence === "number" && Number.isFinite(event.sequence)
              ? Math.max(0, Math.trunc(event.sequence))
              : 0
        })) ?? [],
      windows: result.windows ?? (result.note ? [result.note] : []),
      candidates: result.candidates?.map((candidate) => normalizeCandidate(candidate)) ?? []
    };
  }

  async validateAction(action: DesktopAction, context: BridgeActionContext) {
    return (await this.request("policy.validateAction", {
      actionId: action.id,
      actionKind: action.kind,
      approvalTokenJson: context.approvalToken ? JSON.stringify(context.approvalToken) : "",
      runId: context.runId,
      target: action.target ?? "",
      text: typeof action.args.text === "string" ? action.args.text : "",
      argsJson: JSON.stringify(action.args ?? {}),
      targetDescriptorJson: action.targetDescriptor ? JSON.stringify(action.targetDescriptor) : ""
    }, 10_000)) as { allowed: boolean; reason: string };
  }

  async restart(options?: { args?: string[]; command?: string }) {
    if (options?.command) {
      this.command = options.command;
    }
    if (options?.args) {
      this.args = [...options.args];
    }

    this.startPromise = undefined;
    if (!this.process) {
      return;
    }

    const processToStop = this.process;
    this.process = undefined;
    this.stdoutReader?.close();
    this.stdoutReader = undefined;
    this.rejectPendingRequests(new Error("Bridge process restarted."));
    processToStop.kill();
  }

  private async request(method: string, params?: Record<string, string>, timeoutMs = this.timeoutForMethod(method)) {
    await this.ensureStarted();
    const bridgeProcess = this.process;
    if (!bridgeProcess) {
      throw new Error(`Bridge process is not running for request ${method}.`);
    }

    const id = randomUUID();
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request timed out after ${timeoutMs}ms (${method}).`));
        void this.restart().catch((error) => {
          console.warn(`Bridge restart after timeout failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      bridgeProcess.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(id);
          }
          reject(error);
        }
      });
    });
  }

  private async ensureStarted() {
    if (this.process) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.process = child;

      let started = false;
      const failStart = (error: Error) => {
        if (this.process === child) {
          this.process = undefined;
        }
        this.stdoutReader?.close();
        this.stdoutReader = undefined;
        this.rejectPendingRequests(error);
        if (!started) {
          reject(error);
        }
      };

      child.once("spawn", () => {
        started = true;
        resolve();
      });

      child.once("error", (error) => {
        const wrapped =
          error instanceof Error
            ? new Error(`Failed to start bridge process "${this.command}": ${error.message}`)
            : new Error(`Failed to start bridge process "${this.command}".`);
        failStart(wrapped);
      });

      const stdout = createInterface({ input: child.stdout });
      this.stdoutReader = stdout;
      stdout.on("line", (line) => {
        try {
          const response = JSON.parse(line) as BridgeJsonRpcResponse;
          const pending = this.pending.get(response.id);
          if (!pending) {
            return;
          }

          this.pending.delete(response.id);
          clearTimeout(pending.timeout);
          if (response.error) {
            pending.reject(new Error(response.error.message));
            return;
          }

          pending.resolve(response.result);
        } catch (error) {
          this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
        }
      });

      child.stderr.on("data", (chunk) => {
        const message = chunk.toString("utf8").trim();
        if (message) {
          console.warn(`[lobster-bridge] ${message}`);
        }
      });

      child.once("exit", (code, signal) => {
        if (this.process === child) {
          this.process = undefined;
        }
        this.stdoutReader?.close();
        this.stdoutReader = undefined;
        const exitError = new Error(
          `Bridge process exited unexpectedly with code ${code ?? "unknown"} and signal ${signal ?? "none"}.`
        );
        if (!started) {
          reject(exitError);
          return;
        }
        this.rejectPendingRequests(exitError);
      });
    });

    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private rejectPendingRequests(reason: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private timeoutForMethod(method: string) {
    switch (method) {
      case "bridge.configureKnownApplications":
      case "bridge.describeCapabilities":
      case "bridge.searchApplications":
      case "policy.validateAction":
        return 10_000;
      case "observation.snapshot":
        return 15_000;
      case "ui.performAction":
        return 30_000;
      default:
        return 15_000;
    }
  }
}

export function createBridgeClient(): BridgeClient {
  const bridgeBinary = normalizeBridgeBinary(process.env.LOBSTER_BRIDGE_BIN);
  const args = process.env.LOBSTER_BRIDGE_ARGS?.split(" ").filter(Boolean) ?? [];
  return new ManagedBridgeClient(bridgeBinary, args);
}

class ManagedBridgeClient implements BridgeClient {
  private inner: BridgeClient;

  constructor(private command?: string, private args: string[] = []) {
    this.inner = instantiateBridgeClient(command, args);
  }

  async configureKnownApplications(applications: string[]) {
    await this.inner.configureKnownApplications(applications);
  }

  async describeCapabilities() {
    return this.inner.describeCapabilities();
  }

  async searchApplications(query: string) {
    return this.inner.searchApplications(query);
  }

  async performAction(action: DesktopAction, context: BridgeActionContext) {
    return this.inner.performAction(action, context);
  }

  async snapshot() {
    return this.inner.snapshot();
  }

  async validateAction(action: DesktopAction, context: BridgeActionContext) {
    return this.inner.validateAction(action, context);
  }

  async restart(options?: { args?: string[]; command?: string }) {
    const nextCommand = normalizeBridgeBinary(options?.command ?? this.command);
    const nextArgs = options?.args ? [...options.args] : [...this.args];
    const shouldSwapImplementation =
      (this.inner instanceof StubBridgeClient && Boolean(nextCommand)) ||
      (this.inner instanceof ChildProcessBridgeClient && !nextCommand);

    if (shouldSwapImplementation) {
      await this.inner.restart?.();
      this.command = nextCommand;
      this.args = nextArgs;
      this.inner = instantiateBridgeClient(nextCommand, nextArgs);
      return;
    }

    this.command = nextCommand;
    this.args = nextArgs;
    await this.inner.restart?.({
      command: nextCommand,
      args: nextArgs
    });
  }
}

function instantiateBridgeClient(command: string | undefined, args: string[]) {
  if (!command) {
    return new StubBridgeClient();
  }

  return new ChildProcessBridgeClient(command, args);
}

function normalizeBridgeBinary(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

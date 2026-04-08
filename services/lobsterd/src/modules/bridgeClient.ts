import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ApprovalToken, DesktopAction, DesktopObservation } from "@lobster/shared";
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
  policyHardGate: boolean;
  screenCapture: boolean;
};

export type BridgeActionResult = {
  status: string;
};

export interface BridgeClient {
  configureKnownApplications(applications: string[]): Promise<void>;
  describeCapabilities(): Promise<BridgeCapabilities>;
  searchApplications(query: string): Promise<string[]>;
  performAction(action: DesktopAction, approvalToken?: ApprovalToken): Promise<BridgeActionResult>;
  snapshot(): Promise<DesktopObservation>;
  validateAction(action: DesktopAction, approvalToken?: ApprovalToken): Promise<{ allowed: boolean; reason: string }>;
}

export class StubBridgeClient implements BridgeClient {
  private knownApplications = getKnownApplications();
  private state: DesktopObservation = {
    screenshotRef: "stub://snapshot/latest",
    activeApp: "Lobster Stub Desktop",
    activeWindowTitle: "Discovery Workspace",
    ocrText: ["Stub desktop snapshot"],
    windows: ["Discovery Workspace"],
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
      policyHardGate: true,
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

  async performAction(action: DesktopAction, approvalToken?: ApprovalToken): Promise<BridgeActionResult> {
    const validation = await this.validateAction(action, approvalToken);
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
        return { status: `typed:${text.length}` };
      }
      case "ui.hotkey": {
        const keys =
          (typeof action.args.keys === "string" && action.args.keys.trim()) ||
          (typeof action.args.hotkey === "string" && action.args.hotkey.trim()) ||
          "unknown";
        return { status: `hotkey:${keys}` };
      }
      case "ui.scroll": {
        const direction =
          (typeof action.args.direction === "string" && action.args.direction.trim()) ||
          "down";
        const amount =
          (typeof action.args.amount === "string" && action.args.amount.trim()) ||
          "320";
        return { status: `scrolled:${direction}:${amount}` };
      }
      default:
        return { status: `stubbed:${action.kind}` };
    }
  }

  async snapshot(): Promise<DesktopObservation> {
    return {
      ...this.state,
      windows: [...this.state.windows],
      ocrText: [...this.state.ocrText],
      candidates: this.state.candidates.map((candidate) => ({
        ...candidate,
        bounds: candidate.bounds ? { ...candidate.bounds } : undefined
      }))
    };
  }

  async validateAction(action: DesktopAction, approvalToken?: ApprovalToken) {
    if (action.riskLevel === "red") {
      return {
        allowed: false,
        reason: `Stub bridge rejected redline action ${action.kind}.`
      };
    }

    if (action.riskLevel === "yellow" && !approvalToken) {
      return {
        allowed: false,
        reason: `Stub bridge requires approval for ${action.kind}.`
      };
    }

    return {
      allowed: true,
      reason: "Action allowed by stub bridge."
    };
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
  private readonly pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
    }
  >();

  constructor(private readonly command: string, private readonly args: string[] = []) {}

  async configureKnownApplications(applications: string[]) {
    await this.request("bridge.configureKnownApplications", {
      appsJson: JSON.stringify(applications)
    });
  }

  async describeCapabilities() {
    return (await this.request("bridge.describeCapabilities")) as BridgeCapabilities;
  }

  async searchApplications(query: string) {
    return (await this.request("bridge.searchApplications", {
      query
    })) as string[];
  }

  async performAction(action: DesktopAction, approvalToken?: ApprovalToken) {
    return (await this.request("ui.performAction", {
      actionKind: action.kind,
      approvalToken: approvalToken?.id ?? "",
      target: action.target ?? "",
      text: typeof action.args.text === "string" ? action.args.text : "",
      argsJson: JSON.stringify(action.args ?? {})
    })) as BridgeActionResult;
  }

  async snapshot(): Promise<DesktopObservation> {
    const result = (await this.request("observation.snapshot")) as {
      activeApp?: string;
      activeWindowTitle?: string;
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
      note?: string;
      screenshotRef?: string;
      windows?: string[];
    };

    return {
      screenshotRef: result.screenshotRef ?? "bridge://unknown",
      activeApp: result.activeApp ?? "Unknown",
      activeWindowTitle: result.activeWindowTitle ?? result.note,
      ocrText: result.note ? [result.note] : [],
      windows: result.windows ?? (result.note ? [result.note] : []),
      candidates:
        result.candidates?.map((candidate) => ({
          id: candidate.id ?? randomUUID(),
          role: candidate.role ?? "Unknown",
          label: candidate.label ?? "",
          value: typeof candidate.value === "string" ? candidate.value : undefined,
          focused: typeof candidate.focused === "boolean" ? candidate.focused : undefined,
          bounds: candidate.bounds,
          confidence: candidate.confidence ?? 0.5,
          source: candidate.source ?? "ax"
        })) ?? []
    };
  }

  async validateAction(action: DesktopAction, approvalToken?: ApprovalToken) {
    return (await this.request("policy.validateAction", {
      actionKind: action.kind,
      approvalToken: approvalToken?.id ?? ""
    })) as { allowed: boolean; reason: string };
  }

  private async request(method: string, params?: Record<string, string>) {
    this.ensureStarted();

    const id = randomUUID();
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private ensureStarted() {
    if (this.process) {
      return;
    }

    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout = createInterface({ input: this.process.stdout });
    stdout.on("line", (line) => {
      try {
        const response = JSON.parse(line) as BridgeJsonRpcResponse;
        const pending = this.pending.get(response.id);
        if (!pending) {
          return;
        }

        this.pending.delete(response.id);
        if (response.error) {
          pending.reject(new Error(response.error.message));
          return;
        }

        pending.resolve(response.result);
      } catch (error) {
        for (const [, pending] of this.pending) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.pending.clear();
      }
    });

    this.process.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        console.warn(`[lobster-bridge] ${message}`);
      }
    });

    this.process.once("exit", (code, signal) => {
      const reason = new Error(
        `Bridge process exited unexpectedly with code ${code ?? "unknown"} and signal ${signal ?? "none"}.`
      );

      for (const [, pending] of this.pending) {
        pending.reject(reason);
      }
      this.pending.clear();
      this.process = undefined;
    });
  }
}

export function createBridgeClient(): BridgeClient {
  const bridgeBinary = process.env.LOBSTER_BRIDGE_BIN;
  if (!bridgeBinary) {
    return new StubBridgeClient();
  }

  const args = process.env.LOBSTER_BRIDGE_ARGS?.split(" ").filter(Boolean) ?? [];
  return new ChildProcessBridgeClient(bridgeBinary, args);
}

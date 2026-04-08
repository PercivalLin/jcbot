import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ApprovalToken, DesktopAction, DesktopObservation, TaskRequest } from "@lobster/shared";
import { createRuntimePersistence } from "../../../../packages/storage/src/index.js";
import { ModelRouter } from "../modules/modelRouter.js";
import { StubBridgeClient, type BridgeActionResult, type BridgeCapabilities, type BridgeClient } from "../modules/bridgeClient.js";
import type { ChatPluginInstance } from "../modules/chatPluginRegistry.js";
import { NoopRuntimeNotifier } from "../modules/runtimeNotifier.js";
import { consumeNewlineDelimitedChunk, RpcServer } from "./rpcServer.js";

function createTestRouter() {
  return new ModelRouter({
    planner: {
      role: "planner",
      provider: "openai",
      modelId: "gpt-4.1",
      timeoutMs: 1_000,
      budget: {
        inputTokens: 1000,
        outputTokens: 300
      },
      fallback: []
    },
    vision: {
      role: "vision",
      provider: "anthropic",
      modelId: "claude-3-7-sonnet-latest",
      timeoutMs: 1_000,
      budget: {
        inputTokens: 1000,
        outputTokens: 300
      },
      fallback: []
    },
    executor: {
      role: "executor",
      provider: "google",
      modelId: "gemini-2.0-flash",
      timeoutMs: 1_000,
      budget: {
        inputTokens: 1000,
        outputTokens: 300
      },
      fallback: []
    },
    critic: {
      role: "critic",
      provider: "openai-compatible",
      modelId: "qwen2.5",
      baseURL: "http://localhost:11434/v1",
      timeoutMs: 1_000,
      budget: {
        inputTokens: 1000,
        outputTokens: 300
      },
      fallback: []
    }
  });
}

function createTask(text: string): TaskRequest {
  return {
    id: `task-${text}`,
    source: "system",
    userId: "tester",
    text,
    attachments: [],
    riskPreference: "auto",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString()
  };
}

class NonVerifyingBridgeClient implements BridgeClient {
  async configureKnownApplications() {
    return;
  }

  async describeCapabilities(): Promise<BridgeCapabilities> {
    return {
      accessibility: true,
      eventTap: true,
      ocr: false,
      policyHardGate: true,
      screenCapture: true
    };
  }

  async searchApplications(_query: string): Promise<string[]> {
    return [];
  }

  async performAction(_action: DesktopAction, _approvalToken?: ApprovalToken): Promise<BridgeActionResult> {
    return {
      status: "performed"
    };
  }

  async snapshot(): Promise<DesktopObservation> {
    return {
      screenshotRef: "stub://snapshot/failure",
      activeApp: "Finder",
      activeWindowTitle: "Finder Window",
      ocrText: [],
      windows: ["Finder Window"],
      candidates: [
        {
          id: "search-field",
          role: "text field",
          label: "Search",
          value: "",
          focused: false,
          confidence: 0.9,
          source: "ax"
        }
      ]
    };
  }

  async validateAction(_action: DesktopAction, _approvalToken?: ApprovalToken) {
    return {
      allowed: true,
      reason: "Allowed for verification test."
    };
  }
}

class RecoveringTypingBridgeClient implements BridgeClient {
  public actionAttempts = 0;

  async configureKnownApplications() {
    return;
  }

  async describeCapabilities(): Promise<BridgeCapabilities> {
    return {
      accessibility: true,
      eventTap: true,
      ocr: false,
      policyHardGate: true,
      screenCapture: true
    };
  }

  async searchApplications(_query: string): Promise<string[]> {
    return [];
  }

  async performAction(_action: DesktopAction, _approvalToken?: ApprovalToken): Promise<BridgeActionResult> {
    this.actionAttempts += 1;
    return {
      status: "performed"
    };
  }

  async snapshot(): Promise<DesktopObservation> {
    const typedValue = this.actionAttempts >= 2 ? "hello world" : "";
    return {
      screenshotRef: "stub://snapshot/recovering",
      activeApp: "Finder",
      activeWindowTitle: "Finder Window",
      ocrText: [],
      windows: ["Finder Window"],
      candidates: [
        {
          id: "search-field",
          role: "text field",
          label: "Search",
          value: typedValue,
          focused: this.actionAttempts > 0,
          confidence: 0.9,
          source: "ax"
        }
      ]
    };
  }

  async validateAction(_action: DesktopAction, _approvalToken?: ApprovalToken) {
    return {
      allowed: true,
      reason: "Allowed for recovery test."
    };
  }
}

class LaunchAckOnlyBridgeClient implements BridgeClient {
  async configureKnownApplications() {
    return;
  }

  async describeCapabilities(): Promise<BridgeCapabilities> {
    return {
      accessibility: true,
      eventTap: true,
      ocr: false,
      policyHardGate: true,
      screenCapture: true
    };
  }

  async searchApplications(_query: string): Promise<string[]> {
    return [];
  }

  async performAction(action: DesktopAction, _approvalToken?: ApprovalToken): Promise<BridgeActionResult> {
    if (action.kind === "ui.open_app") {
      return {
        status: "opened:Finder"
      };
    }
    return {
      status: "performed"
    };
  }

  async snapshot(): Promise<DesktopObservation> {
    return {
      screenshotRef: "stub://snapshot/launch-ack",
      activeApp: "桌面",
      activeWindowTitle: "Desktop",
      ocrText: [],
      windows: ["Desktop"],
      candidates: []
    };
  }

  async validateAction(_action: DesktopAction, _approvalToken?: ApprovalToken) {
    return {
      allowed: true,
      reason: "Allowed for launch-ack test."
    };
  }
}

class ContactAckOnlyBridgeClient extends StubBridgeClient {
  async performAction(action: DesktopAction, approvalToken?: ApprovalToken): Promise<BridgeActionResult> {
    if (action.kind === "external.select_contact") {
      const contact =
        (typeof action.args.contact === "string" && action.args.contact.trim()) ||
        (typeof action.target === "string" && action.target.trim()) ||
        "unknown";
      return {
        status: `selected-contact:${contact}`
      };
    }

    return super.performAction(action, approvalToken);
  }

  async snapshot(): Promise<DesktopObservation> {
    return {
      screenshotRef: "stub://snapshot/contact-ack-only",
      activeApp: "WeChat",
      activeWindowTitle: "WeChat",
      ocrText: [],
      windows: ["WeChat"],
      candidates: [
        {
          id: "contact-search",
          role: "text field",
          label: "Search",
          value: "",
          focused: false,
          confidence: 0.95,
          source: "ax"
        }
      ]
    };
  }
}

class AmbiguousAppSearchBridgeClient extends StubBridgeClient {
  async searchApplications(_query: string): Promise<string[]> {
    return ["Calendar", "Notion Calendar"];
  }
}

class ContactCandidatesBridgeClient extends StubBridgeClient {
  constructor(private readonly contactLabels: string[]) {
    super();
  }

  async snapshot(): Promise<DesktopObservation> {
    const base = await super.snapshot();
    return {
      ...base,
      activeApp: "WeChat",
      activeWindowTitle: "WeChat",
      windows: ["WeChat Main Window"],
      candidates: [
        {
          id: "contact-search",
          role: "text field",
          label: "Search",
          value: "",
          focused: false,
          confidence: 0.95,
          source: "ax"
        },
        ...this.contactLabels.map((label, index) => ({
          id: `contact-${index}`,
          role: "button",
          label,
          focused: false,
          confidence: 0.91,
          source: "ax" as const
        }))
      ]
    };
  }
}

class SemanticCandidatesBridgeClient extends StubBridgeClient {
  constructor(
    private readonly options: {
      activeApp?: string;
      activeWindowTitle?: string;
      windows?: string[];
      candidates?: Array<{
        role: string;
        label: string;
      }>;
    }
  ) {
    super();
  }

  async snapshot(): Promise<DesktopObservation> {
    const base = await super.snapshot();
    return {
      ...base,
      activeApp: this.options.activeApp ?? base.activeApp,
      activeWindowTitle: this.options.activeWindowTitle ?? base.activeWindowTitle,
      windows: this.options.windows ?? base.windows,
      candidates:
        this.options.candidates?.map((candidate, index) => ({
          id: `semantic-${index}`,
          role: candidate.role,
          label: candidate.label,
          focused: false,
          confidence: 0.9,
          source: "ax" as const
        })) ?? base.candidates
    };
  }
}

describe("RpcServer runtime flow", () => {
  it("issues an approval ticket for yellow tasks and completes after approval", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("编辑当前文档"));

    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.state).toBe("pending");

    const approved = await server.approveTicket(created.approvalTicket!.id, "tester");

    expect(approved.run.status).toBe("completed");
    expect(approved.token.riskLevel).toBe("yellow");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("creates follow-up runs for whitelisted notification signals", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const result = await server.ingestNotification({
      app: "WhatsApp",
      body: "New ping from Alice",
      title: "Alice",
      timestamp: new Date("2026-01-01T00:00:00.000Z").toISOString()
    });

    expect("item" in result && result.item?.linkedRunId).toBeTruthy();
    expect((await server.listRuns()).length).toBe(1);

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("returns configured chat plugin instances", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins,
        notificationWhitelist: ["WeChat", "Mail"]
      }
    );

    expect(server.listChatPlugins()).toEqual(plugins);

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("uses chat plugin strategy hints when planning message actions", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins,
        notificationWhitelist: ["WeChat"]
      }
    );

    const created = await server.createTask(createTask('在微信给Alice发送消息 "hello"'));
    const selectStep = created.run.plan.find((step) => step.action.kind === "external.select_contact");
    const sendStep = created.run.plan.find((step) => step.action.kind === "external.send_message");

    expect(selectStep).toBeDefined();
    expect(selectStep?.action.args.searchLabelHints).toContain("搜索");
    expect(sendStep).toBeDefined();
    expect(sendStep?.action.args.sendLabelHints).toContain("发送");
    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.state).toBe("pending");

    const approved = await server.approveTicket(created.approvalTicket!.id, "tester");
    expect(approved.run.status).toBe("blocked");
    expect(approved.run.outcomeSummary).toContain("hard redline");
    expect(approved.run.outcomeSummary).toContain("redline.outbound-message");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("runs file upload only after yellow approvals", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins
      }
    );

    const created = await server.createTask(createTask('在微信给 Alice 发文件 "/tmp/report.pdf"'));
    const uploadStep = created.run.plan.find((step) => step.action.kind === "external.upload_file");

    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.action.kind).toBe("external.select_contact");
    expect(uploadStep?.action.riskLevel).toBe("yellow");

    const afterSelectApproval = await server.approveTicket(created.approvalTicket!.id, "tester");
    expect(afterSelectApproval.run.status).toBe("awaiting_approval");
    expect(afterSelectApproval.approvalTicket?.action.kind).toBe("external.upload_file");

    const afterUploadApproval = await server.approveTicket(afterSelectApproval.approvalTicket!.id, "tester");
    expect(afterUploadApproval.run.status).toBe("completed");
    expect(afterUploadApproval.run.outcomeSummary).toContain("upload was dispatched");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("infers upload flow from document-transfer phrasing and normalizes contact prefixes", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];

    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins
      }
    );

    const created = await server.createTask(createTask("在微信把 rbcc学习文档发送给微信文件传输助手"));
    const selectStep = created.run.plan.find((step) => step.action.kind === "external.select_contact");
    const uploadStep = created.run.plan.find((step) => step.action.kind === "external.upload_file");
    const sendStep = created.run.plan.find((step) => step.action.kind === "external.send_message");

    expect(selectStep?.action.target).toBe("文件传输助手");
    expect(uploadStep).toBeDefined();
    expect(sendStep).toBeUndefined();
    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.action.kind).toBe("external.select_contact");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("resolves local file path before upload when instruction only contains a document name", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const documentPath = join(runtimeDir, "rbcc学习文档.pdf");
    writeFileSync(documentPath, "stub");

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];

    const previousRoots = process.env.LOBSTER_FILE_SEARCH_ROOTS;
    process.env.LOBSTER_FILE_SEARCH_ROOTS = runtimeDir;

    try {
      const server = new RpcServer(
        join(runtimeDir, "lobsterd.sock"),
        createTestRouter(),
        persistence,
        new StubBridgeClient(),
        new NoopRuntimeNotifier(),
        {
          chatPlugins: plugins
        }
      );

      const created = await server.createTask(createTask("找一下rbcc学习文档在哪里，然后发送给微信文件传输助手"));
      const uploadStep = created.run.plan.find((step) => step.action.kind === "external.upload_file");
      const selectStep = created.run.plan.find((step) => step.action.kind === "external.select_contact");

      expect(selectStep?.action.target).toBe("文件传输助手");
      expect(uploadStep).toBeDefined();
      expect(uploadStep?.action.args.filePath).toBe(documentPath);
      expect(created.run.status).toBe("awaiting_approval");
      expect(created.approvalTicket?.action.kind).toBe("external.select_contact");
    } finally {
      if (previousRoots === undefined) {
        delete process.env.LOBSTER_FILE_SEARCH_ROOTS;
      } else {
        process.env.LOBSTER_FILE_SEARCH_ROOTS = previousRoots;
      }
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("blocks upload planning when local file search is ambiguous", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    writeFileSync(join(runtimeDir, "rbcc学习文档-v1.pdf"), "stub");
    writeFileSync(join(runtimeDir, "rbcc学习文档-v2.pdf"), "stub");

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];

    const previousRoots = process.env.LOBSTER_FILE_SEARCH_ROOTS;
    process.env.LOBSTER_FILE_SEARCH_ROOTS = runtimeDir;

    try {
      const server = new RpcServer(
        join(runtimeDir, "lobsterd.sock"),
        createTestRouter(),
        persistence,
        new StubBridgeClient(),
        new NoopRuntimeNotifier(),
        {
          chatPlugins: plugins
        }
      );

      const created = await server.createTask(createTask("找一下 rbcc学习文档 在哪里，然后发送给微信文件传输助手"));

      expect(created.run.status).toBe("blocked");
      expect(created.run.outcomeSummary).toContain("目标存在歧义");
      expect(created.run.outcomeSummary).toContain("rbcc学习文档-v1.pdf");
      expect(created.run.outcomeSummary).toContain("rbcc学习文档-v2.pdf");
    } finally {
      if (previousRoots === undefined) {
        delete process.env.LOBSTER_FILE_SEARCH_ROOTS;
      } else {
        process.env.LOBSTER_FILE_SEARCH_ROOTS = previousRoots;
      }
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("completes a contact-switch task after one yellow approval", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins,
        notificationWhitelist: ["WeChat"]
      }
    );

    const created = await server.createTask(createTask("在微信切换到 Alice 聊天"));
    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.action.kind).toBe("external.select_contact");
    expect(created.approvalTicket?.action.target).toBe("Alice");

    const approved = await server.approveTicket(created.approvalTicket!.id, "tester");
    expect(approved.run.status).toBe("completed");
    expect(approved.run.outcomeSummary).toContain('Contact "Alice" appears selected');

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("falls back to generic chat plugin template for known chat apps without explicit plugin config", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("在 Telegram 切换到 Alice 聊天"));
    const selectStep = created.run.plan.find((step) => step.action.kind === "external.select_contact");

    expect(selectStep).toBeDefined();
    expect(selectStep?.action.args.app).toBe("Telegram");
    expect(selectStep?.action.args.searchLabelHints).toContain("Search");
    expect(created.run.status).toBe("awaiting_approval");

    const approved = await server.approveTicket(created.approvalTicket!.id, "tester");
    expect(approved.run.status).toBe("completed");
    expect(approved.run.outcomeSummary).toContain('Contact "Alice" appears selected');

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("infers an enabled chat plugin when chat task does not mention app name", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });

    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];

    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins
      }
    );

    const created = await server.createTask(createTask('给 Alice 发消息 "hello"'));
    const selectStep = created.run.plan.find((step) => step.action.kind === "external.select_contact");

    expect(selectStep).toBeDefined();
    expect(selectStep?.action.args.app).toBe("WeChat");
    expect(selectStep?.action.target).toBe("Alice");
    expect(created.run.status).toBe("awaiting_approval");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("discovers unknown installed app names through bridge search and opens them", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const bridge = new StubBridgeClient();
    await bridge.configureKnownApplications(["Notion Calendar"]);
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      bridge,
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("打开 Notion Calendar"));
    const openStep = created.run.plan.find((step) => step.action.kind === "ui.open_app");

    expect(openStep).toBeDefined();
    expect(openStep?.action.target).toBe("Notion Calendar");
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("accepts bridge launch acknowledgement when snapshot visibility is inconclusive", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new LaunchAckOnlyBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("打开 finder"));

    expect(created.run.status).toBe("completed");
    expect(created.run.outcomeSummary).toContain("Bridge acknowledged ui.open_app for Finder");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("accepts bridge contact-selection acknowledgement when snapshot visibility is inconclusive", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new ContactAckOnlyBridgeClient(),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins
      }
    );

    const created = await server.createTask(createTask("在微信切换到 Alice 聊天"));

    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.action.kind).toBe("external.select_contact");

    const approved = await server.approveTicket(created.approvalTicket!.id, "tester");
    expect(approved.run.status).toBe("completed");
    expect(approved.run.outcomeSummary).toContain("Bridge acknowledged external.select_contact");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("resolves 微信 alias to WeChat when opening app", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("打开微信"));

    const openStep = created.run.plan.find((step) => step.action.kind === "ui.open_app");
    expect(openStep).toBeDefined();
    expect(openStep?.action.target).toBe("WeChat");
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("asks for clarification when app alias matching is ambiguous", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new AmbiguousAppSearchBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("打开 ca"));

    expect(created.run.status).toBe("blocked");
    expect(created.run.outcomeSummary).toContain("应用名存在歧义");
    expect(created.run.outcomeSummary).toContain("Calendar");
    expect(created.run.outcomeSummary).toContain("Notion Calendar");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("builds a multi-step plan for chained natural-language UI instructions", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(
      createTask('打开 Telegram 然后点击 "Search" 然后在 "Search" 输入 "Alice" 然后按下 enter')
    );

    expect(created.run.plan.map((step) => step.action.kind)).toEqual([
      "ui.open_app",
      "ui.click_target",
      "ui.type_into_target",
      "ui.hotkey"
    ]);
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("asks for confirmation when contact target is ambiguous", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new ContactCandidatesBridgeClient(["WSL Team", "WSL Ops", "Alice"]),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins
      }
    );

    const created = await server.createTask(createTask("在微信切换到 wsl 聊天"));

    expect(created.run.status).toBe("blocked");
    expect(created.run.outcomeSummary).toContain("目标存在歧义");
    expect(created.run.outcomeSummary).toContain("WSL Team");
    expect(created.run.outcomeSummary).toContain("WSL Ops");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("auto-normalizes contact target when there is a clear fuzzy match", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const plugins: ChatPluginInstance[] = [
      {
        id: "wechat-main",
        appName: "WeChat",
        aliases: ["微信"],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["附件"],
          composerLabels: ["输入消息"],
          contactSearchLabels: ["搜索"],
          sendButtonLabels: ["发送"]
        }
      }
    ];
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new ContactCandidatesBridgeClient(["WSL Team", "Alice"]),
      new NoopRuntimeNotifier(),
      {
        chatPlugins: plugins
      }
    );

    const created = await server.createTask(createTask("在微信切换到 wsl 聊天"));

    expect(created.run.status).toBe("awaiting_approval");
    expect(created.approvalTicket?.action.kind).toBe("external.select_contact");
    expect(created.approvalTicket?.action.target).toBe("WSL Team");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("asks for confirmation when file target is ambiguous", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new SemanticCandidatesBridgeClient({
        activeApp: "Finder",
        activeWindowTitle: "Downloads",
        windows: ["Downloads"],
        candidates: [
          { role: "row", label: "report_q1.pdf" },
          { role: "row", label: "report_q2.pdf" },
          { role: "text field", label: "Search" }
        ]
      }),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("打开文件 report"));

    expect(created.run.status).toBe("blocked");
    expect(created.run.outcomeSummary).toContain("目标存在歧义");
    expect(created.run.outcomeSummary).toContain("report_q1.pdf");
    expect(created.run.outcomeSummary).toContain("report_q2.pdf");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("auto-normalizes file target when fuzzy match has a clear winner", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new SemanticCandidatesBridgeClient({
        activeApp: "Finder",
        activeWindowTitle: "Downloads",
        windows: ["Downloads"],
        candidates: [
          { role: "row", label: "report_q1.pdf" },
          { role: "row", label: "budget.xlsx" },
          { role: "text field", label: "Search" }
        ]
      }),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("打开文件 reportq1"));
    const normalizedFileStep = created.run.plan.find(
      (step) =>
        (step.action.kind === "ui.type_into_target" || step.action.kind === "ui.type_text") &&
        step.action.args.text === "report_q1.pdf"
    );

    expect(created.run.status).not.toBe("blocked");
    expect(normalizedFileStep).toBeDefined();

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("asks for confirmation when window target is ambiguous", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new SemanticCandidatesBridgeClient({
        activeApp: "Google Chrome",
        activeWindowTitle: "Main - Project A",
        windows: ["Main - Project A", "Main - Project B", "Inbox - Mail"],
        candidates: [{ role: "button", label: "Search" }]
      }),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('切换到 "main" 窗口'));

    expect(created.run.status).toBe("blocked");
    expect(created.run.outcomeSummary).toContain("目标存在歧义");
    expect(created.run.outcomeSummary).toContain("Main - Project A");
    expect(created.run.outcomeSummary).toContain("Main - Project B");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("asks for confirmation when menu target is ambiguous", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new SemanticCandidatesBridgeClient({
        activeApp: "Finder",
        activeWindowTitle: "Finder",
        windows: ["Finder"],
        candidates: [
          { role: "menu item", label: "File" },
          { role: "menu item", label: "Filter" },
          { role: "menu item", label: "Edit" }
        ]
      }),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('选择菜单 "fi"'));

    expect(created.run.status).toBe("blocked");
    expect(created.run.outcomeSummary).toContain("目标存在歧义");
    expect(created.run.outcomeSummary).toContain("File");
    expect(created.run.outcomeSummary).toContain("Filter");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("plans a semantic click action when the user asks to click a named target", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('click "Finder"'));

    expect(created.run.plan.some((step) => step.action.kind === "ui.click_target")).toBe(true);
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("blocks dangerous click targets instead of treating them as normal UI clicks", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('click "发送"'));

    expect(created.run.plan[0]?.action.kind).toBe("external.send_message");
    expect(created.run.status).toBe("blocked");
    expect(created.run.outcomeSummary).toContain("hard redline");
    expect(created.run.outcomeSummary).toContain("redline.outbound-message");
    expect(created.run.outcomeSummary).toContain("safe_alternative=");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("plans target-aware text entry when the request names an input target", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('在 "Search" 输入 "hello world"'));

    const typingStep = created.run.plan.find((step) => step.action.kind === "ui.type_into_target");
    expect(typingStep).toBeDefined();
    expect(typingStep?.action.args.text).toBe("hello world");
    expect(typingStep?.action.args.role).toBe("text field");
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("fails semantic typing when post-action verification cannot find the requested text", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new NonVerifyingBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('在 "Search" 输入 "hello world"'));

    expect(created.run.plan.some((step) => step.action.kind === "ui.type_into_target")).toBe(true);
    expect(created.run.status).toBe("failed");
    expect(created.run.outcomeSummary).toContain('Target "Search" does not show the requested text');

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("retries a recoverable green step once before failing the run", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const bridge = new RecoveringTypingBridgeClient();
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      bridge,
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('在 "Search" 输入 "hello world"'));

    expect(created.run.status).toBe("completed");
    expect(created.run.outcomeSummary).toContain('Target "Search" now contains the requested text');
    expect(bridge.actionAttempts).toBe(2);

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("adds a role hint for semantic click targets when candidate metadata is available", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask('click "Finder"'));

    const clickStep = created.run.plan.find((step) => step.action.kind === "ui.click_target");
    expect(clickStep).toBeDefined();
    expect(clickStep?.action.args.role).toBe("button");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("plans a hotkey step when the request contains a shortcut command", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("按下 cmd+k"));

    const hotkeyStep = created.run.plan.find((step) => step.action.kind === "ui.hotkey");
    expect(hotkeyStep).toBeDefined();
    expect(hotkeyStep?.action.args.keys).toBe("cmd+k");
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("plans a scroll step with direction and amount when requested", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("向下滚动 480"));

    const scrollStep = created.run.plan.find((step) => step.action.kind === "ui.scroll");
    expect(scrollStep).toBeDefined();
    expect(scrollStep?.action.args.direction).toBe("down");
    expect(scrollStep?.action.args.amount).toBe("480");
    expect(created.run.status).toBe("completed");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("keeps low-risk evolution candidates in staging and promotes after review", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const derived = await server.deriveCandidate({
      sourceRunId: "run-safe-1",
      actions: [
        {
          id: "action-safe-1",
          kind: "ui.inspect",
          target: "active-window",
          args: {},
          riskLevel: "green",
          preconditions: [],
          successCheck: []
        }
      ],
      evalScore: 0.95,
      summary: "safe candidate",
      sandboxReplayPassed: true,
      traceRecheckPassed: true,
      noPermissionEscalation: true
    });

    expect(derived.promotionState).toBe("staging");

    const reviewed = await server.reviewStagingCandidate({
      id: derived.id,
      observationWindowPassed: true,
      notes: "staging window passed"
    });
    expect(reviewed.promotionState).toBe("stable");

    const listed = await server.listCapabilityCandidates();
    expect(listed.some((item) => item.id === derived.id && item.promotionState === "stable")).toBe(true);

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("rejects evolution candidates that include redline actions", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const derived = await server.deriveCandidate({
      sourceRunId: "run-red-1",
      actions: [
        {
          id: "action-red-1",
          kind: "external.send_message",
          target: "alice",
          args: {},
          riskLevel: "red",
          preconditions: [],
          successCheck: []
        }
      ],
      evalScore: 0.99,
      summary: "unsafe candidate",
      sandboxReplayPassed: true,
      traceRecheckPassed: true,
      noPermissionEscalation: true
    });

    expect(derived.promotionState).toBe("rejected");
    expect(derived.reason).toContain("hard redline");

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("deduplicates repeated task requests by request id", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const request = createTask("打开 Finder");
    const first = await server.createTask(request);
    const second = await server.createTask({ ...request });
    const runs = await server.listRuns();

    expect(second.run.runId).toBe(first.run.runId);
    expect(runs).toHaveLength(1);

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("rejects repeated approval decisions for a settled ticket", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const created = await server.createTask(createTask("编辑当前文档"));
    await server.approveTicket(created.approvalTicket!.id, "tester");

    await expect(server.approveTicket(created.approvalTicket!.id, "tester")).rejects.toThrow(
      /already approved/i
    );

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("deduplicates identical notification signals into one inbox item and one run", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "lobster-rpc-"));
    const persistence = await createRuntimePersistence({
      path: join(runtimeDir, "runtime.sqlite")
    });
    const server = new RpcServer(
      join(runtimeDir, "lobsterd.sock"),
      createTestRouter(),
      persistence,
      new StubBridgeClient(),
      new NoopRuntimeNotifier()
    );

    const signal = {
      app: "WhatsApp",
      title: "Alice",
      body: "Ping",
      timestamp: "2026-01-01T00:00:00.000Z"
    };

    await server.ingestNotification(signal);
    await server.ingestNotification(signal);

    const runs = await server.listRuns();
    const inboxItems = await persistence.listInboxItems();

    expect(runs).toHaveLength(1);
    expect(inboxItems).toHaveLength(1);

    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("buffers newline-delimited RPC chunks until a full line is available", () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: "health-1",
      method: "health.ping",
      params: {}
    });

    const first = consumeNewlineDelimitedChunk("", request.slice(0, 18));
    expect(first.lines).toEqual([]);
    expect(first.buffer).toBe(request.slice(0, 18));

    const second = consumeNewlineDelimitedChunk(first.buffer, request.slice(18) + "\n");
    expect(second.buffer).toBe("");
    expect(second.lines).toEqual([request]);
  });
});

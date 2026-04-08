import { randomUUID } from "node:crypto";
import type { DesktopAction, DesktopObservation, TaskRun } from "@lobster/shared";
import {
  getChatPluginApplications,
  matchKnownApplication,
  resolveApplicationAlias
} from "@lobster/skills";
import type { ChatPluginInstance } from "./chatPluginRegistry.js";

type OperationTemplateInput = {
  text: string;
  observation?: DesktopObservation;
  chatPlugins?: ChatPluginInstance[];
};

export type OperationTemplateMatch = {
  plan: TaskRun["plan"];
  templateId: string;
};

const OPEN_APP_VERB = /(?:open|launch|start|activate|打开|启动|运行|切换到|进入)/i;
const FILE_NOUN = /(?:file|文件|文档|document)/i;
const EDIT_VERB = /(?:edit|modify|change|rewrite|replace|编辑|修改|改写|替换)/i;
const SHARE_FILE_INTENT =
  /(?:发送文件|发文件|upload file|send file|share file|传文件|附件|attach file|把.+文件.+给|给.+发.+文件)/i;
const CHAT_INTENT_HINT = /(?:聊天|消息|联系人|会话|chat|message|contact|reply|私信|dm)/i;
const COMPLEX_FLOW_HINT =
  /(?:然后|接着|随后|之后|并且|and then|then|click|点击|输入|type|hotkey|按下|滚动|scroll)/i;

export function tryBuildOperationTemplatePlan(input: OperationTemplateInput): OperationTemplateMatch | undefined {
  const text = input.text.trim();
  if (!text) {
    return undefined;
  }

  const shareFilePlan = buildShareFilePlan(text, input);
  if (shareFilePlan) {
    return {
      templateId: "chat.share-file",
      plan: shareFilePlan
    };
  }

  const editFilePlan = buildEditFilePlan(text);
  if (editFilePlan) {
    return {
      templateId: "file.edit",
      plan: editFilePlan
    };
  }

  const openFilePlan = buildOpenFilePlan(text);
  if (openFilePlan) {
    return {
      templateId: "file.open",
      plan: openFilePlan
    };
  }

  const openAppPlan = buildOpenAppPlan(text);
  if (openAppPlan) {
    return {
      templateId: "app.open",
      plan: openAppPlan
    };
  }

  return undefined;
}

function buildOpenAppPlan(text: string): TaskRun["plan"] | undefined {
  if (!OPEN_APP_VERB.test(text)) {
    return undefined;
  }

  if (CHAT_INTENT_HINT.test(text) || COMPLEX_FLOW_HINT.test(text)) {
    return undefined;
  }

  if (SHARE_FILE_INTENT.test(text)) {
    return undefined;
  }

  const appName = resolveOpenTarget(text);
  if (!appName) {
    return undefined;
  }

  if (FILE_NOUN.test(text)) {
    return undefined;
  }

  return [
    createStep(
      `Open ${appName}`,
      "Template: open an application",
      {
        kind: "ui.open_app",
        target: appName,
        args: {
          app: appName,
          text
        },
        riskLevel: "green",
        preconditions: [],
        successCheck: [`${appName} is visible`]
      },
      ["Try activating an existing window", "Ask the user to open the app manually"],
      [`${appName} is active`]
    )
  ];
}

function buildOpenFilePlan(text: string): TaskRun["plan"] | undefined {
  if (!OPEN_APP_VERB.test(text)) {
    return undefined;
  }

  const fileRef = extractFileReference(text);
  if (!fileRef && !FILE_NOUN.test(text)) {
    return undefined;
  }

  const resolvedRef = fileRef ?? "pending-file";
  const intent = "Template: open file via Finder";
  const steps: TaskRun["plan"] = [
    createStep(
      "Open Finder",
      intent,
      {
        kind: "ui.open_app",
        target: "Finder",
        args: {
          app: "Finder",
          text
        },
        riskLevel: "green",
        preconditions: [],
        successCheck: ["Finder is visible"]
      },
      ["Try activating an existing Finder window"],
      ["Finder is active"]
    )
  ];

  if (looksLikePath(resolvedRef)) {
    steps.push(
      createStep(
        "Open Go To Folder",
        intent,
        {
          kind: "ui.hotkey",
          target: "Finder",
          args: { keys: "cmd+shift+g" },
          riskLevel: "green",
          preconditions: ["Finder is active"],
          successCheck: ["Go To Folder input is visible"]
        },
        ["Use Finder search as fallback"],
        ["Go To Folder dialog opened"]
      )
    );
    steps.push(
      createStep(
        "Type File Path",
        intent,
        {
          kind: "ui.type_text",
          target: "current-focus",
          args: { text: resolvedRef },
          riskLevel: "green",
          preconditions: ["Go To Folder input is focused"],
          successCheck: ["Path is typed into current focus"]
        },
        ["Ask user to confirm exact file path"],
        ["Path text entered"]
      )
    );
    steps.push(
      createStep(
        "Confirm Open Path",
        intent,
        {
          kind: "ui.hotkey",
          target: "Finder",
          args: { keys: "enter" },
          riskLevel: "green",
          preconditions: ["Path text entered"],
          successCheck: ["Target folder or file opens"]
        },
        ["Retry once with explicit absolute path"],
        ["File context opened"]
      )
    );
    return steps;
  }

  steps.push(
    createStep(
      "Search File In Finder",
      intent,
      {
        kind: "ui.type_into_target",
        target: "Search",
        args: {
          label: "Search",
          role: "text field",
          text: resolvedRef
        },
        riskLevel: "green",
        preconditions: ["Finder search box is visible"],
        successCheck: ["Search query contains target file name"]
      },
      ["Use Go To Folder with absolute path instead"],
      ["Search query entered"]
    )
  );
  steps.push(
    createStep(
      "Open First Search Result",
      intent,
      {
        kind: "ui.hotkey",
        target: "Finder",
        args: { keys: "enter" },
        riskLevel: "green",
        preconditions: ["Search result list is focused"],
        successCheck: ["A result is opened"]
      },
      ["Ask user to specify exact path to avoid ambiguous names"],
      ["File opened"]
    )
  );
  return steps;
}

function buildEditFilePlan(text: string): TaskRun["plan"] | undefined {
  if (!EDIT_VERB.test(text) || !FILE_NOUN.test(text)) {
    return undefined;
  }

  const fileRef = extractFileReference(text) ?? "pending-file";
  const instruction = extractEditInstruction(text);
  const intent = "Template: open file in editor and apply controlled edit";

  return [
    createStep(
      "Open Editor",
      intent,
      {
        kind: "ui.open_app",
        target: "Visual Studio Code",
        args: {
          app: "Visual Studio Code",
          text
        },
        riskLevel: "green",
        preconditions: [],
        successCheck: ["Visual Studio Code is visible"]
      },
      ["Fallback to TextEdit if VS Code is unavailable"],
      ["Editor is active"]
    ),
    createStep(
      "Open Quick File Picker",
      intent,
      {
        kind: "ui.hotkey",
        target: "Visual Studio Code",
        args: { keys: "cmd+p" },
        riskLevel: "green",
        preconditions: ["Editor is active"],
        successCheck: ["Quick file picker is visible"]
      },
      ["Use File menu as fallback"],
      ["File picker opened"]
    ),
    createStep(
      "Type Target File",
      intent,
      {
        kind: "ui.type_text",
        target: "current-focus",
        args: { text: fileRef },
        riskLevel: "green",
        preconditions: ["Quick file picker has focus"],
        successCheck: ["Target file reference is typed"]
      },
      ["Ask user for exact file path"],
      ["File reference entered"]
    ),
    createStep(
      "Confirm File Open",
      intent,
      {
        kind: "ui.hotkey",
        target: "Visual Studio Code",
        args: { keys: "enter" },
        riskLevel: "green",
        preconditions: ["Target file reference entered"],
        successCheck: ["File tab is visible"]
      },
      ["Retry with absolute path"],
      ["File opened in editor"]
    ),
    createStep(
      "Apply Structured Edit",
      intent,
      {
        kind: "ui.edit_existing",
        target: fileRef,
        args: {
          file: fileRef,
          instruction
        },
        riskLevel: "yellow",
        preconditions: ["File tab is active", "Current content snapshot captured"],
        successCheck: ["Diff matches requested edit instruction"]
      },
      ["Ask user to approve a narrower edit scope", "Switch to manual patch mode"],
      ["Edit completed with verification"]
    )
  ];
}

function buildShareFilePlan(text: string, input: OperationTemplateInput): TaskRun["plan"] | undefined {
  if (!SHARE_FILE_INTENT.test(text)) {
    return undefined;
  }

  const appName = resolvePreferredChatApp(text, input.chatPlugins, input.observation);
  const contact = extractContact(text) ?? "pending-contact";
  const fileRef = extractFileReference(text) ?? "pending-file";
  const sourceUrl = extractUrl(text);
  const intent = "Template: prepare chat upload flow with policy guardrails";
  const steps: TaskRun["plan"] = [];

  if (!matchesActiveApp(input.observation, appName)) {
    steps.push(
      createStep(
        `Open ${appName}`,
        intent,
        {
          kind: "ui.open_app",
          target: appName,
          args: {
            app: appName,
            text
          },
          riskLevel: "green",
          preconditions: [],
          successCheck: [`${appName} is visible`]
        },
        ["Try activating an existing app window"],
        [`${appName} is active`]
      )
    );
  }

  if (sourceUrl) {
    steps.push(
      createStep(
        "Open Browser For Source Artifact",
        intent,
        {
          kind: "ui.open_app",
          target: "Safari",
          args: {
            app: "Safari",
            text: sourceUrl
          },
          riskLevel: "green",
          preconditions: [],
          successCheck: ["Browser is active"]
        },
        ["Switch to another browser if Safari is unavailable"],
        ["Browser opened"]
      )
    );
    steps.push(
      createStep(
        "Navigate To Source URL",
        intent,
        {
          kind: "ui.type_text",
          target: "current-focus",
          args: { text: sourceUrl },
          riskLevel: "green",
          preconditions: ["Address bar is focused"],
          successCheck: ["URL is typed into browser"]
        },
        ["Ask user to provide direct downloadable link"],
        ["URL entered"]
      )
    );
    steps.push(
      createStep(
        "Load Source URL",
        intent,
        {
          kind: "ui.hotkey",
          target: "Safari",
          args: { keys: "enter" },
          riskLevel: "green",
          preconditions: ["URL is entered"],
          successCheck: ["Page is loaded for download preparation"]
        },
        ["Retry with a different source link"],
        ["Source page loaded"]
      )
    );
  }

  steps.push(
    createStep(
      `Select Contact ${contact}`,
      intent,
      {
        kind: "external.select_contact",
        target: contact,
        args: {
          app: appName,
          contact
        },
        riskLevel: "yellow",
        preconditions: ["Contact search UI is available"],
        successCheck: ["Chat header matches target contact"]
      },
      ["Ask user to confirm the exact contact alias"],
      [`${contact} is selected`]
    )
  );
  steps.push(
    createStep(
      "Open Attachment Entry",
      intent,
      {
        kind: "ui.click_target",
        target: "Attach",
        args: {
          label: "Attach",
          role: "button"
        },
        riskLevel: "green",
        preconditions: ["Chat composer is visible"],
        successCheck: ["Attachment picker is opened"]
      },
      ["Try alternate label: 附件", "Fallback to plus button"],
      ["Upload picker opened"]
    )
  );
  steps.push(
    createStep(
      "Attempt Upload (Redline Guarded)",
      intent,
      {
        kind: "external.upload_file",
        target: contact,
        args: {
          app: appName,
          contact,
          filePath: fileRef,
          ...(sourceUrl ? { sourceUrl } : {})
        },
        riskLevel: "yellow",
        preconditions: ["Attachment picker is ready", "File reference is resolved"],
        successCheck: ["A valid one-time approval token is present"]
      },
      ["Request explicit approval and retry with the issued token"],
      ["Upload action is evaluated under yellow-line approval"]
    )
  );

  return steps;
}

function resolveOpenTarget(text: string) {
  const hint = extractApplicationHint(text);
  if (hint) {
    return resolveApplicationAlias(hint);
  }

  const matched = matchKnownApplication(text);
  if (matched) {
    return resolveApplicationAlias(matched);
  }

  return undefined;
}

function resolvePreferredChatApp(
  text: string,
  chatPlugins: ChatPluginInstance[] | undefined,
  observation: DesktopObservation | undefined
) {
  const normalizedText = normalizeToken(text);
  const enabledPlugins = (chatPlugins ?? []).filter((plugin) => plugin.enabled);

  for (const plugin of enabledPlugins) {
    const names = [plugin.appName, ...plugin.aliases];
    if (names.some((name) => normalizedText.includes(normalizeToken(name)))) {
      return plugin.appName;
    }
  }

  const knownChatApps = Array.from(
    new Set([
      ...getChatPluginApplications(),
      ...enabledPlugins.map((plugin) => plugin.appName)
    ])
  );
  for (const appName of knownChatApps) {
    if (normalizedText.includes(normalizeToken(appName))) {
      return appName;
    }
  }

  const activeApp = observation?.activeApp?.trim();
  if (activeApp && knownChatApps.some((entry) => normalizeToken(entry) === normalizeToken(activeApp))) {
    return activeApp;
  }

  if (enabledPlugins[0]?.appName) {
    return enabledPlugins[0].appName;
  }

  return "WeChat";
}

function extractApplicationHint(text: string) {
  const quoted =
    text.match(/(?:open|launch|start|activate|打开|启动|运行|切换到|进入)\s*[“"']([^“"']{1,80})[”"']/i)?.[1] ??
    text.match(/(?:open|launch|start|activate|打开|启动|运行|切换到|进入)\s+([^\n,，。:：]{1,80})/i)?.[1];
  const normalized = quoted?.trim();
  if (!normalized) {
    return undefined;
  }

  if (/^(app|application|应用|软件|program)$/i.test(normalized)) {
    return undefined;
  }

  if (FILE_NOUN.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function extractFileReference(text: string) {
  const quotedSegments = [...text.matchAll(/[“"']([^“"']{1,260})[”"']/g)].map(
    (segment) => segment[1]?.trim() ?? ""
  );
  const quotedPath = quotedSegments.find((segment) => looksLikePath(segment));
  if (quotedPath) {
    return quotedPath;
  }

  const unixPath = text.match(/((?:\/|~\/|\.\/)[^\s,，。]{2,260})/i)?.[1]?.trim();
  if (unixPath) {
    return unixPath;
  }

  const windowsPath = text.match(/([A-Za-z]:\\[^\s,，。]{2,260})/)?.[1]?.trim();
  if (windowsPath) {
    return windowsPath;
  }

  const fileName = text.match(/\b([^\s,，。/\\]{1,120}\.[A-Za-z0-9]{1,12})\b/)?.[1]?.trim();
  if (fileName) {
    return fileName;
  }

  return undefined;
}

function extractContact(text: string) {
  const direct =
    text.match(/(?:给|发给|发送给|上传给)\s*[“"']?([^“"'\s,，。:：]{1,40})[”"']?/i)?.[1] ??
    text.match(/(?:to|contact)\s+[“"']?([^“"'\n,，。:：]{1,40})[”"']?/i)?.[1] ??
    text.match(/(?:和|与)\s*[“"']?([^“"'\n,，。:：]{1,40})[”"']?\s*(?:聊天|对话|会话|联系人)/i)?.[1];

  return direct?.trim();
}

function extractUrl(text: string) {
  return text.match(/https?:\/\/[^\s,，。]+/i)?.[0]?.trim();
}

function extractEditInstruction(text: string) {
  const afterDelimiter =
    text.split(/(?:然后|并|并且|再|并把|并将|把|将)\s*/).map((entry) => entry.trim()).find((entry) => EDIT_VERB.test(entry));
  return (afterDelimiter ?? text).trim();
}

function looksLikePath(value: string) {
  if (!value) {
    return false;
  }
  if (/^(?:\/|~\/|\.\/)/.test(value)) {
    return true;
  }
  if (/^[A-Za-z]:\\/.test(value)) {
    return true;
  }
  if (/[\\/]/.test(value)) {
    return true;
  }
  return /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function matchesActiveApp(observation: DesktopObservation | undefined, appName: string) {
  if (!observation?.activeApp) {
    return false;
  }
  const active = normalizeToken(observation.activeApp);
  const expected = normalizeToken(appName);
  return active.includes(expected) || expected.includes(active);
}

function normalizeToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function createStep(
  title: string,
  intent: string,
  action: Omit<DesktopAction, "id">,
  fallback: string[],
  successCriteria: string[]
): TaskRun["plan"][number] {
  return {
    id: randomUUID(),
    title,
    intent,
    action: {
      id: randomUUID(),
      ...action
    },
    fallback,
    successCriteria
  };
}

import { describe, expect, it } from "vitest";
import type { DesktopObservation } from "@lobster/shared";
import type { ChatPluginInstance } from "./chatPluginRegistry.js";
import { tryBuildOperationTemplatePlan } from "./operationTemplates.js";

const emptyObservation: DesktopObservation = {
  screenshotRef: "stub://snapshot",
  activeApp: "Finder",
  activeWindowTitle: "Finder",
  ocrText: [],
  windows: ["Finder"],
  candidates: []
};

describe("operationTemplates", () => {
  it("builds an app.open template for 打开微信", () => {
    const result = tryBuildOperationTemplatePlan({
      text: "打开微信",
      observation: emptyObservation
    });

    expect(result?.templateId).toBe("app.open");
    expect(result?.plan[0]?.action.kind).toBe("ui.open_app");
    expect(result?.plan[0]?.action.target).toBe("WeChat");
  });

  it("builds a file.open template for path-based open requests", () => {
    const result = tryBuildOperationTemplatePlan({
      text: "打开文件 /Users/demo/report.pdf",
      observation: emptyObservation
    });

    expect(result?.templateId).toBe("file.open");
    expect(result?.plan.map((step) => step.action.kind)).toEqual([
      "ui.open_app",
      "ui.hotkey",
      "ui.type_text",
      "ui.hotkey"
    ]);
    expect(result?.plan[2]?.action.args.text).toBe("/Users/demo/report.pdf");
  });

  it("builds a file.edit template with yellow guarded edit step", () => {
    const result = tryBuildOperationTemplatePlan({
      text: '修改文件 "src/main.ts" 把 foo 改成 bar',
      observation: emptyObservation
    });

    expect(result?.templateId).toBe("file.edit");
    const finalAction = result?.plan.at(-1)?.action;
    expect(finalAction?.kind).toBe("ui.edit_existing");
    expect(finalAction?.riskLevel).toBe("yellow");
  });

  it("builds a chat.share-file template with yellow upload approval step", () => {
    const plugins: ChatPluginInstance[] = [
      {
        id: "chat-telegram",
        appName: "Telegram",
        aliases: [],
        channel: "chat-app",
        enabled: true,
        capabilities: ["external.select_contact", "ui.type_into_target", "ui.click_target"],
        strategy: {
          attachmentButtonLabels: ["Attach"],
          composerLabels: ["Message"],
          contactSearchLabels: ["Search"],
          sendButtonLabels: ["Send"]
        }
      }
    ];
    const result = tryBuildOperationTemplatePlan({
      text: '给 Alice 发文件 "/tmp/report.pdf" 在 Telegram',
      observation: emptyObservation,
      chatPlugins: plugins
    });

    expect(result?.templateId).toBe("chat.share-file");
    expect(result?.plan.some((step) => step.action.kind === "external.select_contact")).toBe(true);
    const uploadStep = result?.plan.find((step) => step.action.kind === "external.upload_file");
    expect(uploadStep?.action.riskLevel).toBe("yellow");
    expect(uploadStep?.action.args.app).toBe("Telegram");
  });

  it("returns undefined for plain chat text", () => {
    const result = tryBuildOperationTemplatePlan({
      text: "你好，今天天气怎么样",
      observation: emptyObservation
    });
    expect(result).toBeUndefined();
  });
});

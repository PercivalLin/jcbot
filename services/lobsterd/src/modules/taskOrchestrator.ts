import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { END, START, Annotation, StateGraph } from "@langchain/langgraph";
import {
  type ApprovalToken,
  type ApprovalTicket,
  type DesktopAction,
  type DesktopObservation,
  type PolicyDecision,
  type RunEvent,
  type SelfCheckResult,
  type TaskRequest,
  type TaskRun,
  type TargetDescriptor,
  type VerificationEvidenceItem,
  type VerificationResult
} from "@lobster/shared";
import { evaluateActionAgainstConstitution, flattenRules, loadConstitution } from "@lobster/policy";
import { gateAction } from "@lobster/policy";
import {
  getChatPluginApplications,
  getKnownApplications,
  matchKnownApplication,
  resolveApplicationAlias
} from "@lobster/skills";
import { ModelRouter } from "./modelRouter.js";
import type { BridgeClient } from "./bridgeClient.js";
import type { ChatPluginInstance } from "./chatPluginRegistry.js";
import {
  buildPlannerPrompt,
  buildVisionVerificationPrompt,
  buildVisionVerificationSystemPrompt
} from "./modelRoles.js";
import { tryBuildOperationTemplatePlan } from "./operationTemplates.js";
import { resolveWorkspaceConfigFile } from "./paths.js";

const CONSTITUTION_PATH = resolveWorkspaceConfigFile({
  importMetaUrl: import.meta.url,
  name: "constitution.yaml"
});

const OrchestratorState = Annotation.Root({
  run: Annotation<TaskRun>({
    reducer: (_prev, next) => next,
    default: () => ({
      runId: "placeholder",
      request: {
        id: "placeholder",
        source: "system",
        userId: "system",
        text: "placeholder",
        attachments: [],
        riskPreference: "auto",
        createdAt: new Date(0).toISOString()
      },
      status: "queued",
      riskLevel: "green",
      plan: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    })
  }),
  observation: Annotation<DesktopObservation | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  approvalToken: Annotation<ApprovalToken | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  selfCheck: Annotation<SelfCheckResult | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  decision: Annotation<PolicyDecision | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  executionReport: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  })
});

const GENERIC_CHAT_PLUGIN_STRATEGY: ChatPluginInstance["strategy"] = {
  attachmentButtonLabels: ["Attach", "附件", "发送文件", "+"],
  composerLabels: ["Message", "消息", "输入", "输入消息"],
  contactSearchLabels: ["Search", "搜索", "联系人", "Contact"],
  sendButtonLabels: ["Send", "发送"]
};

const GENERIC_CHAT_PLUGIN_CAPABILITIES = [
  "external.select_contact",
  "ui.type_into_target",
  "ui.click_target"
];

type ApplicationResolutionResult =
  | {
      status: "resolved";
      appName: string;
    }
  | {
      status: "ambiguous";
      hint: string;
      options: string[];
    }
  | {
      status: "unresolved";
      hint: string;
      options: string[];
    };

type SemanticTargetResolutionResult =
  | {
      status: "resolved";
      value: string;
    }
  | {
      status: "ambiguous";
      hint: string;
      options: string[];
    }
  | {
      status: "unresolved";
      hint: string;
      options: string[];
    };

type SemanticTargetContext = {
  kind: "contact" | "ui-target" | "file" | "window";
  hint: string;
  preferredRole?: string;
};

type LocalFileResolutionResult =
  | {
      status: "resolved";
      path: string;
    }
  | {
      status: "ambiguous";
      hint: string;
      options: string[];
    }
  | {
      status: "unresolved";
      hint: string;
      options: string[];
    };

export class TaskOrchestrator {
  private readonly rules = flattenRules(loadConstitution(CONSTITUTION_PATH));
  private readonly maxRecoverableAttemptsPerStep = 2;
  private readonly graph = new StateGraph(OrchestratorState)
    .addNode("contextBuild", async (state) => {
      const observation = await this.bridgeClient.snapshot();
      const run = {
        ...state.run,
        latestObservation: observation,
        status: "context_build" as const,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(run, "run.status_changed", "Observing current desktop state.");
      return { observation, run };
    })
    .addNode("planDraft", async (state) => {
      const plan =
        state.run.plan.length > 0 ? state.run.plan : await this.createPlan(state.run.request, state.observation);
      const currentStepId =
        state.run.currentStepId && plan.some((step) => step.id === state.run.currentStepId)
          ? state.run.currentStepId
          : plan[0]?.id;

      const run = {
        ...state.run,
        status: "planned" as const,
        currentStepId,
        plan,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(run, "run.status_changed", "Task plan is ready.");
      return { run };
    })
    .addNode("selfCheckPass", async (state) => {
      const action = this.resolveCurrentAction(state.run);
      const selfCheck = evaluateActionAgainstConstitution(action, this.rules);
      const run = {
        ...state.run,
        status: "self_checked" as const,
        riskLevel: selfCheck.overallRisk,
        selfCheck,
        outcomeSummary: undefined,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(run, "run.status_changed", "Policy self-check finished.");
      return { run, selfCheck };
    })
    .addNode("riskGate", async (state) => {
      const action = this.resolveCurrentAction(state.run);
      const decision = gateAction({
        action,
        selfCheck: state.selfCheck ?? evaluateActionAgainstConstitution(action, this.rules),
        approvalToken: state.approvalToken
      });
      const status: TaskRun["status"] = decision.allowed
        ? "executing"
        : decision.requiresApproval
          ? "awaiting_approval"
          : "blocked";

      const run = {
        ...state.run,
        status,
        outcomeSummary: decision.allowed ? undefined : decision.reason,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(
        run,
        decision.requiresApproval ? "approval.requested" : "run.status_changed",
        decision.allowed ? "Action cleared risk gate." : decision.reason
      );
      return { run, decision };
    })
    .addNode("execute", async (state) => {
      if (!state.decision?.allowed) {
        return {};
      }

      const action = this.resolveCurrentAction(state.run);
      const bridgeDecision = await this.bridgeClient.validateAction(action, state.approvalToken);
      if (!bridgeDecision.allowed) {
        const status: TaskRun["status"] = action.riskLevel === "yellow" ? "awaiting_approval" : "blocked";
        return {
          decision: {
            allowed: false,
            riskLevel: action.riskLevel,
            requiresApproval: action.riskLevel === "yellow" && !state.approvalToken,
            reason: bridgeDecision.reason,
            ruleIds: state.selfCheck?.findings.map((finding) => finding.ruleId) ?? []
          },
          run: {
            ...state.run,
            status,
            outcomeSummary: bridgeDecision.reason,
            updatedAt: new Date().toISOString()
          }
        };
      }

      const execution = await this.bridgeClient.performAction(action, state.approvalToken);
      const run = {
        ...state.run,
        status: "verifying" as const,
        verification: undefined,
        outcomeSummary: execution.status,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(run, "run.status_changed", `Action dispatched: ${execution.status}`);
      return { executionReport: execution.status, run };
    })
    .addNode("verify", async (state) => {
      if (!state.decision?.allowed) {
        return {};
      }

      const action = this.resolveCurrentAction(state.run);
      const settledObservation = await this.capturePostActionObservation(
        action,
        state.observation,
        state.executionReport
      );
      const verification = await this.refineVerificationWithVision(
        action,
        state.observation,
        settledObservation.observation,
        settledObservation.verification
      );
      const run = {
        ...state.run,
        status: this.statusForVerification(verification),
        latestObservation: settledObservation.observation,
        verification,
        outcomeSummary: verification.message,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(run, "run.status_changed", verification.message);
      return { observation: settledObservation.observation, executionReport: verification.message, run };
    })
    .addNode("report", async (state) => {
      const denialExplanation =
        state.decision && !state.decision.allowed
          ? this.buildDenialExplanation(
              state.decision,
              state.selfCheck,
              this.resolveCurrentAction(state.run)
            )
          : state.executionReport;

      return {
        run: {
          ...state.run,
          status: state.run.status,
          outcomeSummary: denialExplanation,
          updatedAt: new Date().toISOString()
        },
        executionReport: denialExplanation
      };
    })
    .addConditionalEdges("riskGate", (state) => (state.decision?.allowed ? "execute" : "report"), {
      execute: "execute",
      report: "report"
    })
    .addEdge("execute", "verify")
    .addEdge("verify", "report")
    .addEdge("report", END)
    .addEdge(START, "contextBuild")
    .addEdge("contextBuild", "planDraft")
    .addEdge("planDraft", "selfCheckPass")
    .addEdge("selfCheckPass", "riskGate")
    .compile();

  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly bridgeClient: BridgeClient,
    private readonly options: {
      chatPlugins?: ChatPluginInstance[];
      onRunEvent?: (event: RunEvent, run: TaskRun) => Promise<void>;
    } = {}
  ) {}

  async createRun(request: TaskRequest): Promise<{ run: TaskRun; approvalTicket?: ApprovalTicket }> {
    const normalizedRequest = await this.normalizeRequestApplicationTarget(request);
    if ("blockedRun" in normalizedRequest) {
      await this.emitRunEvent(
        normalizedRequest.blockedRun,
        "run.created",
        normalizedRequest.blockedRun.outcomeSummary ?? "Task blocked during application resolution."
      );
      return {
        run: normalizedRequest.blockedRun
      };
    }

    const semanticNormalizedRequest = await this.normalizeRequestSemanticTargets(normalizedRequest.request);
    if ("blockedRun" in semanticNormalizedRequest) {
      await this.emitRunEvent(
        semanticNormalizedRequest.blockedRun,
        "run.created",
        semanticNormalizedRequest.blockedRun.outcomeSummary ?? "Task blocked during semantic target resolution."
      );
      return {
        run: semanticNormalizedRequest.blockedRun
      };
    }

    const runtimeRequest = semanticNormalizedRequest.request;
    const run: TaskRun = {
      runId: randomUUID(),
      request: runtimeRequest,
      status: "queued",
      riskLevel: "green",
      plan: [],
      latestObservation: undefined,
      outcomeSummary: undefined,
      createdAt: runtimeRequest.createdAt,
      updatedAt: runtimeRequest.createdAt
    };
    await this.emitRunEvent(run, "run.created", "Task accepted and queued.");
    return this.continueRun(run);
  }

  async resumeRun(
    run: TaskRun,
    approvalToken: ApprovalToken
  ): Promise<{ run: TaskRun; approvalTicket?: ApprovalTicket }> {
    return this.continueRun(run, approvalToken);
  }

  private async continueRun(
    run: TaskRun,
    approvalToken?: ApprovalToken
  ): Promise<{ run: TaskRun; approvalTicket?: ApprovalTicket }> {
    let nextRun = run;
    let token = approvalToken;
    const stepAttempts = new Map<string, number>();

    while (true) {
      const state = await this.graph.invoke({ run: nextRun, approvalToken: token });
      nextRun = state.run;

      const currentStep = this.resolveCurrentStep(nextRun);
      if (state.decision?.allowed && currentStep) {
        stepAttempts.set(currentStep.id, (stepAttempts.get(currentStep.id) ?? 0) + 1);
      }

      if (state.decision?.requiresApproval && currentStep && nextRun.selfCheck) {
        await this.emitRunEvent(nextRun, "approval.requested", this.buildApprovalReason(state.decision.reason, nextRun.selfCheck));
        return {
          run: nextRun,
          approvalTicket: {
            id: randomUUID(),
            runId: nextRun.runId,
            reason: this.buildApprovalReason(state.decision.reason, nextRun.selfCheck),
            action: currentStep.action,
            findings: nextRun.selfCheck.findings,
            createdAt: new Date().toISOString(),
            state: "pending"
          }
        };
      }

      if (!state.decision?.allowed) {
        return { run: nextRun };
      }

      if (nextRun.status === "failed") {
        if (currentStep) {
          const attempts = stepAttempts.get(currentStep.id) ?? 1;
          if (this.shouldRetryFailedStep(currentStep.action, attempts)) {
            nextRun = {
              ...nextRun,
              status: "queued",
              verification: undefined,
              outcomeSummary: this.buildRecoverySummary(currentStep.action, attempts, nextRun.outcomeSummary),
              updatedAt: new Date().toISOString()
            };
            await this.emitRunEvent(nextRun, "run.note", nextRun.outcomeSummary ?? "Retrying failed step.");
            token = undefined;
            continue;
          }
        }

        return { run: nextRun };
      }

      if (nextRun.status === "blocked") {
        return { run: nextRun };
      }

      const currentStepIndex = this.resolveCurrentStepIndex(nextRun);
      const nextStep = nextRun.plan[currentStepIndex + 1];
      if (!nextStep) {
        return { run: nextRun };
      }

      nextRun = {
        ...nextRun,
        currentStepId: nextStep.id,
        status: "queued",
        verification: undefined,
        updatedAt: new Date().toISOString()
      };
      await this.emitRunEvent(nextRun, "run.step_advanced", `Advancing to step ${nextStep.title}.`);
      token = undefined;
    }
  }

  private async emitRunEvent(run: TaskRun, kind: RunEvent["kind"], message: string) {
    if (!this.options.onRunEvent) {
      return;
    }

    await this.options.onRunEvent(
      {
        eventId: randomUUID(),
        runId: run.runId,
        kind,
        status: run.status,
        stepId: run.currentStepId,
        message,
        createdAt: new Date().toISOString()
      },
      run
    );
  }

  private buildApprovalReason(baseReason: string, selfCheck: SelfCheckResult) {
    const findings = selfCheck.findings.map((finding) => finding.ruleId).join(", ");
    return findings ? `${baseReason} Triggered rules: ${findings}.` : baseReason;
  }

  private statusForVerification(verification: VerificationResult): TaskRun["status"] {
    switch (verification.status) {
      case "verified":
        return "completed";
      case "dispatched_unverified":
        return "blocked";
      case "failed":
        return "failed";
    }
  }

  private buildDenialExplanation(
    decision: PolicyDecision,
    selfCheck: SelfCheckResult | undefined,
    action: DesktopAction
  ) {
    const findings = selfCheck?.findings ?? [];
    if (findings.length === 0) {
      return decision.reason;
    }

    const ruleDetails = findings.map((finding) =>
      `[${finding.ruleId}] risk=${finding.riskLevel}; reason=${finding.whyFlagged}; safe_alternative=${finding.proposedSafeAlternative}`
    );

    const guidance = decision.requiresApproval
      ? "This is a yellow action. Use a one-time ApprovalToken to continue."
      : decision.riskLevel === "red"
        ? "This is a hard redline action and cannot be overridden."
        : undefined;

    return [
      decision.reason,
      `action=${action.kind}`,
      ...ruleDetails,
      guidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async normalizeRequestApplicationTarget(
    request: TaskRequest
  ): Promise<{ request: TaskRequest } | { blockedRun: TaskRun }> {
    const text = request.text.trim();
    if (!text || !this.shouldNormalizeApplicationRequest(text)) {
      return { request };
    }
    if (/(file|文件|文档|document)/i.test(text)) {
      return { request };
    }

    const hint = this.extractApplicationHint(text);
    if (!hint) {
      return { request };
    }

    const resolution = await this.resolveApplicationFromHint(hint);
    if (resolution.status === "resolved") {
      if (this.normalizeApplicationToken(hint) === this.normalizeApplicationToken(resolution.appName)) {
        return { request };
      }

      const rewritten = this.replaceFirstApplicationHint(request.text, hint, resolution.appName);
      return {
        request: {
          ...request,
          text: rewritten
        }
      };
    }

    const options = resolution.options.slice(0, 5);
    const optionLine = options.length > 0 ? options.join(" / ") : "无候选";
    const suggestion =
      options.length > 0
        ? `请明确应用名后重试，例如：/do 打开 ${options[0]}`
        : "请提供更精确的应用名（可包含完整名称）。";

    return {
      blockedRun: {
        runId: randomUUID(),
        request,
        status: "blocked",
        riskLevel: "green",
        plan: [],
        outcomeSummary:
          resolution.status === "ambiguous"
            ? `应用名存在歧义：${resolution.hint}。候选：${optionLine}。${suggestion}`
            : `无法确认应用名：${resolution.hint}。候选：${optionLine}。${suggestion}`,
        createdAt: request.createdAt,
        updatedAt: new Date().toISOString()
      }
    };
  }

  private async normalizeRequestSemanticTargets(
    request: TaskRequest
  ): Promise<{ request: TaskRequest } | { blockedRun: TaskRun }> {
    const text = request.text.trim();
    if (!text) {
      return { request };
    }

    const contexts: SemanticTargetContext[] = [];
    const rawContactHint = this.matchesChatIntent(text) ? this.extractContactTarget(text) : undefined;
    const contactHint = rawContactHint ? this.normalizeContactTarget(rawContactHint) : undefined;
    if (contactHint) {
      contexts.push({
        kind: "contact",
        hint: contactHint
      });
    }

    const clickHint = this.extractExplicitClickHint(text);
    if (clickHint) {
      contexts.push({
        kind: "ui-target",
        hint: clickHint,
        preferredRole: "button"
      });
    }

    const inputHint = this.extractExplicitInputHint(text);
    if (inputHint) {
      contexts.push({
        kind: "ui-target",
        hint: inputHint,
        preferredRole: "text field"
      });
    }

    const menuHint = this.extractMenuTargetHint(text);
    if (menuHint) {
      contexts.push({
        kind: "ui-target",
        hint: menuHint,
        preferredRole: "menu item"
      });
    }

    const fileHint = this.extractSemanticFileHint(text);
    if (fileHint) {
      contexts.push({
        kind: "file",
        hint: fileHint
      });
    }

    const windowHint = this.extractWindowHint(text);
    if (windowHint) {
      contexts.push({
        kind: "window",
        hint: windowHint
      });
    }

    if (contexts.length === 0) {
      return { request };
    }

    let observation: DesktopObservation | undefined;
    try {
      observation = await this.bridgeClient.snapshot();
    } catch {
      return { request };
    }

    if (!observation || observation.candidates.length === 0) {
      return { request };
    }

    let rewrittenText = request.text;
    for (const context of contexts) {
      if (context.kind === "file" && this.shouldAttemptLocalFileResolution(text, context.hint)) {
        const localFileResolution = this.resolveLocalFileFromHint(context.hint);
        if (localFileResolution.status === "resolved") {
          rewrittenText = this.replaceFirstFileHintWithPath(
            rewrittenText,
            context.hint,
            localFileResolution.path
          );
          continue;
        }

        if (localFileResolution.status === "ambiguous") {
          const optionLine = localFileResolution.options.slice(0, 5).join(" / ");
          const tip = this.buildSemanticTargetClarificationTip(
            context,
            localFileResolution.options,
            localFileResolution.hint
          );
          return {
            blockedRun: {
              runId: randomUUID(),
              request,
              status: "blocked",
              riskLevel: "green",
              plan: [],
              outcomeSummary: `目标存在歧义：${localFileResolution.hint}。候选：${optionLine || "无候选"}。${tip}`,
              createdAt: request.createdAt,
              updatedAt: new Date().toISOString()
            }
          };
        }
      }

      const options = this.collectSemanticTargetOptions(context.kind, observation, context.preferredRole);
      if (options.length === 0) {
        continue;
      }

      const resolution = this.resolveSemanticTargetFromOptions(context.hint, options);
      if (resolution.status === "resolved") {
        const hintKey = this.normalizeEntityToken(context.hint);
        const resolvedKey = this.normalizeEntityToken(resolution.value);
        if (hintKey && resolvedKey && hintKey !== resolvedKey) {
          rewrittenText = this.replaceFirstApplicationHint(rewrittenText, context.hint, resolution.value);
        }
        continue;
      }

      const shouldAskForConfirmation =
        resolution.status === "ambiguous" ||
        (resolution.status === "unresolved" &&
          resolution.options.length > 0 &&
          Math.max(...resolution.options.map((option) => this.scoreSemanticTargetMatch(context.hint, option))) >= 56);
      if (shouldAskForConfirmation) {
        const optionLine = resolution.options.slice(0, 5).join(" / ");
        const tip = this.buildSemanticTargetClarificationTip(context, resolution.options, resolution.hint);
        return {
          blockedRun: {
            runId: randomUUID(),
            request,
            status: "blocked",
            riskLevel: "green",
            plan: [],
            outcomeSummary:
              resolution.status === "ambiguous"
                ? `目标存在歧义：${resolution.hint}。候选：${optionLine || "无候选"}。${tip}`
                : `无法确认目标：${resolution.hint}。候选：${optionLine || "无候选"}。${tip}`,
            createdAt: request.createdAt,
            updatedAt: new Date().toISOString()
          }
        };
      }
    }

    if (rewrittenText === request.text) {
      return { request };
    }

    return {
      request: {
        ...request,
        text: rewrittenText
      }
    };
  }

  private async resolveApplicationFromHint(hint: string): Promise<ApplicationResolutionResult> {
    const knownExact = this.resolveKnownApplicationFromHint(hint);
    if (knownExact) {
      return {
        status: "resolved",
        appName: resolveApplicationAlias(knownExact)
      };
    }

    let matches: string[] = [];
    try {
      matches = await this.bridgeClient.searchApplications(hint);
    } catch {
      matches = [];
    }

    const deduped = Array.from(
      new Map(
        matches
          .map((name) => resolveApplicationAlias(name))
          .map((name) => [name.toLowerCase(), name] as const)
      ).values()
    );

    if (deduped.length === 0) {
      return {
        status: "unresolved",
        hint,
        options: []
      };
    }

    const normalizedHint = this.normalizeApplicationTokenForVerification(hint);
    const exact = deduped.find(
      (candidate) => this.normalizeApplicationTokenForVerification(candidate) === normalizedHint
    );
    if (exact) {
      return {
        status: "resolved",
        appName: exact
      };
    }

    const scored = deduped
      .map((candidate) => ({
        appName: candidate,
        score: this.scoreApplicationMatch(hint, candidate)
      }))
      .sort((left, right) => right.score - left.score || left.appName.localeCompare(right.appName));

    const best = scored[0];
    const second = scored[1];
    const isWeak = best.score < 56;
    const isTooClose = Boolean(second && best.score - second.score < 8);
    if (isWeak || isTooClose) {
      return {
        status: "ambiguous",
        hint,
        options: scored.slice(0, 5).map((item) => item.appName)
      };
    }

    return {
      status: "resolved",
      appName: best.appName
    };
  }

  private resolveSemanticTargetFromOptions(
    hint: string,
    options: string[]
  ): SemanticTargetResolutionResult {
    const deduped = Array.from(
      new Map(
        options
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => [this.normalizeEntityToken(entry), entry] as const)
          .filter(([key]) => Boolean(key))
      ).values()
    );
    if (deduped.length === 0) {
      return {
        status: "unresolved",
        hint,
        options: []
      };
    }

    const normalizedHint = this.normalizeEntityToken(hint);
    if (!normalizedHint) {
      return {
        status: "unresolved",
        hint,
        options: deduped.slice(0, 5)
      };
    }

    const exact = deduped.find((entry) => this.normalizeEntityToken(entry) === normalizedHint);
    if (exact) {
      return {
        status: "resolved",
        value: exact
      };
    }

    const scored = deduped
      .map((entry) => ({
        value: entry,
        score: this.scoreSemanticTargetMatch(hint, entry)
      }))
      .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value));

    const best = scored[0];
    const second = scored[1];
    if (!best || best.score < 62) {
      return {
        status: "unresolved",
        hint,
        options: scored.slice(0, 5).map((entry) => entry.value)
      };
    }

    const secondIsCompetitive = Boolean(second && second.score >= 62 && best.score - second.score < 10);
    const bestIsWeak = best.score < 72 && Boolean(second && second.score >= 56);
    if (secondIsCompetitive || bestIsWeak) {
      return {
        status: "ambiguous",
        hint,
        options: scored.slice(0, 5).map((entry) => entry.value)
      };
    }

    return {
      status: "resolved",
      value: best.value
    };
  }

  private scoreApplicationMatch(hint: string, candidate: string) {
    const hintCollapsed = this.normalizeApplicationTokenForVerification(hint);
    const candidateCollapsed = this.normalizeApplicationTokenForVerification(candidate);
    if (!hintCollapsed || !candidateCollapsed) {
      return 0;
    }

    if (hintCollapsed === candidateCollapsed) {
      return 100;
    }
    if (candidateCollapsed.startsWith(hintCollapsed)) {
      return 93;
    }
    if (candidateCollapsed.includes(hintCollapsed)) {
      return 88;
    }
    if (hintCollapsed.includes(candidateCollapsed)) {
      return 76;
    }

    const hintTokens = this.normalizeApplicationToken(hint)
      .split(/\s+/g)
      .filter(Boolean);
    const candidateTokens = this.normalizeApplicationToken(candidate)
      .split(/\s+/g)
      .filter(Boolean);
    const overlap = hintTokens.filter((token) => candidateTokens.includes(token)).length;
    if (overlap > 0) {
      return 60 + overlap * 8;
    }

    return 35;
  }

  private scoreSemanticTargetMatch(hint: string, candidate: string) {
    const hintCollapsed = this.normalizeEntityToken(hint);
    const candidateCollapsed = this.normalizeEntityToken(candidate);
    if (!hintCollapsed || !candidateCollapsed) {
      return 0;
    }

    if (hintCollapsed === candidateCollapsed) {
      return 100;
    }
    if (candidateCollapsed.startsWith(hintCollapsed)) {
      return 93;
    }
    if (candidateCollapsed.includes(hintCollapsed)) {
      return 88;
    }
    if (hintCollapsed.includes(candidateCollapsed)) {
      return 72;
    }

    const hintTokens = this.normalizeApplicationToken(hint)
      .split(/\s+/g)
      .filter(Boolean);
    const candidateTokens = this.normalizeApplicationToken(candidate)
      .split(/\s+/g)
      .filter(Boolean);
    const overlap = hintTokens.filter((token) => candidateTokens.includes(token)).length;
    if (overlap > 0) {
      return 58 + overlap * 10;
    }

    return 30;
  }

  private replaceFirstApplicationHint(text: string, hint: string, appName: string) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    if (regex.test(text)) {
      return text.replace(regex, appName);
    }
    return text;
  }

  private collectSemanticTargetOptions(
    kind: SemanticTargetContext["kind"],
    observation: DesktopObservation,
    preferredRole?: string
  ) {
    if (kind === "window") {
      return Array.from(
        new Map(
          [observation.activeWindowTitle, ...observation.windows]
            .filter((entry): entry is string => Boolean(entry?.trim()))
            .map((entry) => [this.normalizeEntityToken(entry), entry.trim()] as const)
            .filter(([key]) => Boolean(key))
        ).values()
      );
    }

    const normalizedRole = this.normalizeRoleName(preferredRole);
    const fromCandidates = observation.candidates
      .filter((candidate) => this.roleMatches(this.normalizeRoleName(candidate.role), normalizedRole))
      .map((candidate) => candidate.label.trim())
      .filter(Boolean);

    if (kind === "contact") {
      const knownApps = new Set(
        getKnownApplications()
          .map((entry) => this.normalizeEntityToken(entry))
          .filter(Boolean)
      );
      const blockedTokens = new Set(
        [
          "search",
          "搜索",
          "contact",
          "联系人",
          "message",
          "消息",
          "send",
          "发送",
          "attach",
          "附件",
          "file",
          "上传",
          "chat",
          "聊天",
          "conversation",
          "会话"
        ].map((entry) => this.normalizeEntityToken(entry))
      );
      return Array.from(
        new Map(
          fromCandidates
            .filter((label) => {
              const key = this.normalizeEntityToken(label);
              if (!key || blockedTokens.has(key) || knownApps.has(key)) {
                return false;
              }
              return key.length >= 2 && key.length <= 40;
            })
            .map((label) => [this.normalizeEntityToken(label), label] as const)
        ).values()
      );
    }

    if (kind === "file") {
      const blockedTokens = new Set(
        [
          "search",
          "搜索",
          "send",
          "发送",
          "upload",
          "上传",
          "attach",
          "附件",
          "open",
          "打开",
          "cancel",
          "取消",
          "ok",
          "确定",
          "file",
          "文件",
          "document",
          "文档",
          "folder",
          "目录"
        ].map((entry) => this.normalizeEntityToken(entry))
      );
      return Array.from(
        new Map(
          fromCandidates
            .filter((label) => {
              const key = this.normalizeEntityToken(label);
              if (!key || blockedTokens.has(key)) {
                return false;
              }
              return this.looksLikeSemanticFileLabel(label);
            })
            .map((label) => [this.normalizeEntityToken(label), label] as const)
        ).values()
      );
    }

    return Array.from(
      new Map(fromCandidates.map((label) => [this.normalizeEntityToken(label), label] as const)).values()
    );
  }

  private async createPlan(request: TaskRequest, observation?: DesktopObservation) {
    const templatePlan = tryBuildOperationTemplatePlan({
      text: request.text,
      observation,
      chatPlugins: this.options.chatPlugins
    });
    if (templatePlan) {
      return this.hydratePlanTargetDescriptors(templatePlan.plan, observation);
    }

    const plannerOutput = await this.modelRouter.prompt("planner", buildPlannerPrompt(request.text, observation));

    const heuristicPlan = await this.buildHeuristicPlan(request.text, observation, plannerOutput);
    const plan =
      heuristicPlan.length > 0
        ? heuristicPlan
        : [
          {
            id: randomUUID(),
            title: "Inspect task context",
            intent: plannerOutput,
            action: this.createDiscoveryAction(request.text),
            fallback: ["Ask the user for clarification", "Open the target app in read-only discovery mode"],
            successCriteria: ["Target app is opened or focused", "Relevant UI candidates are identified"]
          }
        ];
    return this.hydratePlanTargetDescriptors(plan, observation);
  }

  private createDiscoveryAction(text: string): DesktopAction {
    if (/send message|发送消息|发消息|reply message|回复消息/i.test(text)) {
      return {
        id: randomUUID(),
        kind: "external.send_message",
        target: "pending-target",
        args: {},
        riskLevel: "red",
        preconditions: ["Resolve the message recipient", "Draft the final message"],
        successCheck: ["Approval token must be present before action execution"]
      };
    }

    if (/upload file|发送文件|发文件/i.test(text)) {
      return {
        id: randomUUID(),
        kind: "external.upload_file",
        target: "pending-target",
        args: {},
        riskLevel: "yellow",
        preconditions: ["Resolve the target contact", "Resolve the file path"],
        successCheck: ["Approval token must be present before action execution"]
      };
    }

    if (/delete|删除/i.test(text)) {
      return {
        id: randomUUID(),
        kind: "file.delete",
        target: "pending-target",
        args: {},
        riskLevel: "red",
        preconditions: ["Resolve the exact deletion target"],
        successCheck: ["Approval token must be present before action execution"]
      };
    }

    if (/edit|修改|编辑/i.test(text)) {
      return {
        id: randomUUID(),
        kind: "ui.edit_existing",
        target: "current-selection",
        args: {},
        riskLevel: "yellow",
        preconditions: ["Capture the current value before editing"],
        successCheck: ["The edited content matches the requested change"]
      };
    }

    if (/联系人|contact|切换/i.test(text)) {
      return {
        id: randomUUID(),
        kind: "external.select_contact",
        target: "pending-contact",
        args: {},
        riskLevel: "yellow",
        preconditions: ["Search results are visible"],
        successCheck: ["Window title or chat header matches the chosen contact"]
      };
    }

    const appHint = this.extractApplicationHint(text);
    if (appHint && this.shouldUseApplicationDiscovery(text)) {
      return {
        id: randomUUID(),
        kind: "ui.open_app",
        target: appHint,
        args: {
          app: appHint,
          text
        },
        riskLevel: "green",
        preconditions: [],
        successCheck: ["Requested app or workspace is visible"]
      };
    }

    return {
      id: randomUUID(),
      kind: "ui.open_app",
      target: "discovery",
      args: { text },
      riskLevel: "green",
      preconditions: [],
      successCheck: ["Requested app or workspace is visible"]
    };
  }

  private async buildHeuristicPlan(
    text: string,
    observation: DesktopObservation | undefined,
    plannerOutput: string
  ) {
    const steps: TaskRun["plan"] = [];
    const referencedApp = await this.resolveReferencedApp(text);
    const chatPlugin = await this.resolveChatPlugin(text, referencedApp, observation);
    const inputTarget = this.extractInputTarget(text, observation);
    const targetLabel = inputTarget ?? this.extractClickTarget(text, observation);
    const targetCandidate = targetLabel ? this.findCandidateByLabel(observation, targetLabel) : undefined;
    const targetRole = this.normalizeRoleName(targetCandidate?.role);
    const typedText = this.extractTypedText(text);
    const hotkeyCombo = this.extractHotkeyCombo(text);
    const scrollRequest = this.extractScrollRequest(text);
    const clauses = this.splitInstructionClauses(text);
    const activeAppMatches = referencedApp
      ? observation?.activeApp.toLowerCase().includes(referencedApp.toLowerCase()) ?? false
      : true;

    if (chatPlugin && this.matchesChatIntent(text)) {
      const chatPlan = this.buildChatPluginPlan({
        text,
        plannerOutput,
        plugin: chatPlugin,
        observation,
        referencedApp,
        activeAppMatches
      });
      if (chatPlan.length > 0) {
        return chatPlan;
      }
    }

    if (!chatPlugin && clauses.length > 1) {
      const sequentialPlan = await this.buildSequentialPlan({
        clauses,
        observation,
        plannerOutput,
        referencedApp,
        activeAppMatches,
        text
      });
      if (sequentialPlan.length > 1) {
        return sequentialPlan;
      }
    }

    if (this.isDangerousTarget(targetLabel)) {
      return [
        {
          id: randomUUID(),
          title: "Refuse dangerous target action",
          intent: plannerOutput,
          action: this.createDiscoveryAction(
            targetLabel && /上传|upload/i.test(targetLabel) ? "upload file" : targetLabel && /删|delete/i.test(targetLabel) ? "delete" : "send message"
          ),
          fallback: ["Ask for explicit approval", "Draft the action without executing it"],
          successCriteria: ["Unsafe target is blocked by policy"]
        }
      ];
    }

    if (referencedApp && !activeAppMatches) {
      steps.push({
        id: randomUUID(),
        title: `Open ${referencedApp}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.open_app",
          target: referencedApp,
          args: {
            app: referencedApp,
            text
          },
          riskLevel: "green",
          preconditions: [],
          successCheck: [`${referencedApp} is active`]
        },
        fallback: ["Try activating an existing app window", "Ask the user to open the app manually"],
        successCriteria: [`${referencedApp} is visible`]
      });
    }

    if (typedText && targetLabel) {
      steps.push({
        id: randomUUID(),
        title: `Type into ${targetLabel}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.type_into_target",
          target: targetLabel,
          args: {
            label: targetLabel,
            text: typedText,
            ...(targetRole ? { role: targetRole } : {})
          },
          riskLevel: "green",
          preconditions: ["The target input is visible in the active window"],
          successCheck: ["The target input contains the requested text"]
        },
        fallback: ["Focus the target first and retry", "Ask the user to confirm the target field"],
        successCriteria: [`${targetLabel} contains the requested text`]
      });
    } else if (targetLabel) {
      steps.push({
        id: randomUUID(),
        title: `Click ${targetLabel}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.click_target",
          target: targetLabel,
          args: {
            label: targetLabel,
            ...(targetRole ? { role: targetRole } : {})
          },
          riskLevel: "green",
          preconditions: ["The target is visible in the active window"],
          successCheck: [`${targetLabel} was pressed or focused`]
        },
        fallback: ["Use coordinates if the target can be verified visually", "Ask for a screenshot or clarification"],
        successCriteria: [`${targetLabel} is activated`]
      });
    }

    if (typedText && !targetLabel) {
      steps.push({
        id: randomUUID(),
        title: "Type requested text",
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.type_text",
          target: targetLabel ?? "current-focus",
          args: {
            text: typedText
          },
          riskLevel: "green",
          preconditions: ["The correct text field is focused"],
          successCheck: ["Typed text matches the requested content"]
        },
        fallback: ["Ask the user to confirm the current focus", "Use a dedicated input-target action in a later revision"],
        successCriteria: ["The requested text is entered"]
      });
    }

    if (hotkeyCombo) {
      steps.push({
        id: randomUUID(),
        title: `Press ${hotkeyCombo}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.hotkey",
          target: "active-app",
          args: {
            keys: hotkeyCombo
          },
          riskLevel: "green",
          preconditions: ["The target application is active"],
          successCheck: [`Hotkey ${hotkeyCombo} is dispatched`]
        },
        fallback: ["Activate the expected app first and retry", "Ask the user to trigger the hotkey manually"],
        successCriteria: [`${hotkeyCombo} is triggered`]
      });
    }

    if (scrollRequest) {
      const amountLabel = `${scrollRequest.amount}px`;
      steps.push({
        id: randomUUID(),
        title: `Scroll ${scrollRequest.direction}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.scroll",
          target: "active-window",
          args: {
            direction: scrollRequest.direction,
            amount: String(scrollRequest.amount),
            deltaX: String(scrollRequest.deltaX),
            deltaY: String(scrollRequest.deltaY)
          },
          riskLevel: "green",
          preconditions: ["The target content area is visible"],
          successCheck: [`Content moved ${scrollRequest.direction} by roughly ${amountLabel}`]
        },
        fallback: ["Retry with a smaller scroll amount", "Click the target pane first and retry"],
        successCriteria: [`Scroll ${scrollRequest.direction} by ${amountLabel}`]
      });
    }

    return steps;
  }

  private resolveCurrentAction(run: TaskRun) {
    return this.resolveCurrentStep(run)?.action ?? this.createDiscoveryAction(run.request.text);
  }

  private resolveCurrentStep(run: TaskRun) {
    return run.plan[this.resolveCurrentStepIndex(run)];
  }

  private resolveCurrentStepIndex(run: TaskRun) {
    if (!run.currentStepId) {
      return 0;
    }

    const index = run.plan.findIndex((step) => step.id === run.currentStepId);
    return index >= 0 ? index : 0;
  }

  private extractReferencedApp(text: string) {
    return matchKnownApplication(text);
  }

  private splitInstructionClauses(text: string) {
    const normalized = text
      .trim()
      .replace(/\s+/g, " ");
    if (!normalized) {
      return [];
    }

    const connectorSplit = normalized.split(
      /\s*(?:然后|接着|随后|之后|再然后|and then|then|after that)\s*/gi
    );
    const clauses = connectorSplit
      .flatMap((segment) => segment.split(/[。；;\n]+/g))
      .map((segment) => segment.trim())
      .filter(Boolean);

    return clauses.slice(0, 8);
  }

  private async resolveReferencedApp(text: string) {
    const hint = this.extractApplicationHint(text);
    const known = this.extractReferencedApp(text);

    if (known && (!hint || this.applicationHintMatchesAppName(hint, known))) {
      return known;
    }

    if (hint && this.shouldUseApplicationDiscovery(text)) {
      try {
        const matches = await this.bridgeClient.searchApplications(hint);
        if (matches.length > 0) {
          return matches[0];
        }
      } catch {
        // Fall through to known app result if bridge search is unavailable.
      }
    }

    if (known) {
      return known;
    }

    if (hint && this.shouldUseApplicationDiscovery(text)) {
      return hint;
    }

    return undefined;
  }

  private async resolveChatPlugin(
    text: string,
    referencedApp?: string,
    observation?: DesktopObservation
  ) {
    const normalized = text.toLowerCase();
    const enabledPlugins = (this.options.chatPlugins ?? []).filter((plugin) => plugin.enabled);
    const configuredMatch = enabledPlugins.find((plugin) => {
      if (!plugin.enabled) {
        return false;
      }

      return [plugin.appName, ...plugin.aliases]
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
        .some((entry) => normalized.includes(entry));
    });
    if (configuredMatch) {
      return configuredMatch;
    }

    if (!this.matchesChatIntent(text)) {
      return undefined;
    }

    if (!referencedApp) {
      return this.inferChatPluginFromEnabledList(enabledPlugins, observation);
    }

    if (!this.isKnownChatApplication(referencedApp)) {
      return this.inferChatPluginFromEnabledList(enabledPlugins, observation);
    }

    return this.createGenericChatPlugin(referencedApp);
  }

  private async inferChatPluginFromEnabledList(
    enabledPlugins: ChatPluginInstance[],
    observation?: DesktopObservation
  ) {
    if (enabledPlugins.length === 0) {
      const activeApp = observation?.activeApp?.trim();
      if (activeApp && this.isKnownChatApplication(activeApp)) {
        return this.createGenericChatPlugin(activeApp);
      }

      const discovered = await this.discoverInstalledChatApplication();
      return discovered ? this.createGenericChatPlugin(discovered) : undefined;
    }

    const activeApp = observation?.activeApp?.trim();
    if (activeApp) {
      const activeMatch = enabledPlugins.find((plugin) =>
        [plugin.appName, ...plugin.aliases]
          .map((value) => this.normalizeApplicationToken(value))
          .includes(this.normalizeApplicationToken(activeApp))
      );
      if (activeMatch) {
        return activeMatch;
      }
    }

    if (enabledPlugins.length === 1) {
      return enabledPlugins[0];
    }

    for (const plugin of enabledPlugins) {
      try {
        const matches = await this.bridgeClient.searchApplications(plugin.appName);
        const hasExact = matches.some(
          (candidate) =>
            this.normalizeApplicationToken(candidate) === this.normalizeApplicationToken(plugin.appName)
        );
        if (hasExact) {
          return plugin;
        }
      } catch {
        // Ignore bridge lookup errors and keep searching.
      }
    }

    return enabledPlugins[0];
  }

  private async discoverInstalledChatApplication() {
    const knownChatApps = getChatPluginApplications();
    for (const appName of knownChatApps) {
      try {
        const matches = await this.bridgeClient.searchApplications(appName);
        const hasExact = matches.some(
          (candidate) =>
            this.normalizeApplicationToken(candidate) === this.normalizeApplicationToken(appName)
        );
        if (hasExact) {
          return appName;
        }
      } catch {
        // Ignore lookup errors and continue with the next candidate.
      }
    }

    return undefined;
  }

  private async buildSequentialPlan(params: {
    activeAppMatches: boolean;
    clauses: string[];
    observation: DesktopObservation | undefined;
    plannerOutput: string;
    referencedApp: string | undefined;
    text: string;
  }) {
    const { activeAppMatches, clauses, observation, plannerOutput, referencedApp, text } = params;
    const steps: TaskRun["plan"] = [];
    const openedApps = new Set<string>();
    let hasExplicitOpenStep = false;

    for (const clause of clauses) {
      const clauseText = clause.trim();
      if (!clauseText) {
        continue;
      }

      const clauseReferencedApp = await this.resolveReferencedApp(clauseText);
      const clauseInputTarget = this.extractInputTarget(clauseText, observation);
      const clauseTarget = clauseInputTarget ?? this.extractClickTarget(clauseText, observation);
      const clauseCandidate = clauseTarget ? this.findCandidateByLabel(observation, clauseTarget) : undefined;
      const clauseRole = this.normalizeRoleName(clauseCandidate?.role);
      const clauseTypedText = this.extractTypedText(clauseText);
      const clauseHotkey = this.extractHotkeyCombo(clauseText);
      const clauseScroll = this.extractScrollRequest(clauseText);
      const clauseWantsOpen = this.shouldUseApplicationDiscovery(clauseText);

      if (this.isDangerousTarget(clauseTarget)) {
        return [
          {
            id: randomUUID(),
            title: "Refuse dangerous target action",
            intent: plannerOutput,
            action: this.createDiscoveryAction(
              clauseTarget && /上传|upload/i.test(clauseTarget)
                ? "upload file"
                : clauseTarget && /删|delete/i.test(clauseTarget)
                  ? "delete"
                  : "send message"
            ),
            fallback: ["Ask for explicit approval", "Draft the action without executing it"],
            successCriteria: ["Unsafe target is blocked by policy"]
          }
        ];
      }

      if (clauseReferencedApp && clauseWantsOpen) {
        const appKey = this.normalizeApplicationToken(clauseReferencedApp);
        if (!openedApps.has(appKey)) {
          steps.push({
            id: randomUUID(),
            title: `Open ${clauseReferencedApp}`,
            intent: plannerOutput,
            action: {
              id: randomUUID(),
              kind: "ui.open_app",
              target: clauseReferencedApp,
              args: {
                app: clauseReferencedApp,
                text: clauseText
              },
              riskLevel: "green",
              preconditions: [],
              successCheck: [`${clauseReferencedApp} is active`]
            },
            fallback: ["Try activating an existing app window", "Ask the user to open the app manually"],
            successCriteria: [`${clauseReferencedApp} is visible`]
          });
          openedApps.add(appKey);
          hasExplicitOpenStep = true;
        }
      }

      if (clauseTypedText && clauseTarget) {
        steps.push({
          id: randomUUID(),
          title: `Type into ${clauseTarget}`,
          intent: plannerOutput,
          action: {
            id: randomUUID(),
            kind: "ui.type_into_target",
            target: clauseTarget,
            args: {
              label: clauseTarget,
              text: clauseTypedText,
              ...(clauseRole ? { role: clauseRole } : {})
            },
            riskLevel: "green",
            preconditions: ["The target input is visible in the active window"],
            successCheck: ["The target input contains the requested text"]
          },
          fallback: ["Focus the target first and retry", "Ask the user to confirm the target field"],
          successCriteria: [`${clauseTarget} contains the requested text`]
        });
      } else if (clauseTypedText) {
        steps.push({
          id: randomUUID(),
          title: "Type requested text",
          intent: plannerOutput,
          action: {
            id: randomUUID(),
            kind: "ui.type_text",
            target: "current-focus",
            args: {
              text: clauseTypedText
            },
            riskLevel: "green",
            preconditions: ["The correct text field is focused"],
            successCheck: ["Typed text matches the requested content"]
          },
          fallback: ["Ask the user to confirm the current focus", "Use a dedicated input-target action in a later revision"],
          successCriteria: ["The requested text is entered"]
        });
      } else if (clauseTarget) {
        steps.push({
          id: randomUUID(),
          title: `Click ${clauseTarget}`,
          intent: plannerOutput,
          action: {
            id: randomUUID(),
            kind: "ui.click_target",
            target: clauseTarget,
            args: {
              label: clauseTarget,
              ...(clauseRole ? { role: clauseRole } : {})
            },
            riskLevel: "green",
            preconditions: ["The target is visible in the active window"],
            successCheck: [`${clauseTarget} was pressed or focused`]
          },
          fallback: ["Use coordinates if the target can be verified visually", "Ask for a screenshot or clarification"],
          successCriteria: [`${clauseTarget} is activated`]
        });
      }

      if (clauseHotkey) {
        steps.push({
          id: randomUUID(),
          title: `Press ${clauseHotkey}`,
          intent: plannerOutput,
          action: {
            id: randomUUID(),
            kind: "ui.hotkey",
            target: "active-app",
            args: {
              keys: clauseHotkey
            },
            riskLevel: "green",
            preconditions: ["The target application is active"],
            successCheck: [`Hotkey ${clauseHotkey} is dispatched`]
          },
          fallback: ["Activate the expected app first and retry", "Ask the user to trigger the hotkey manually"],
          successCriteria: [`${clauseHotkey} is triggered`]
        });
      }

      if (clauseScroll) {
        const amountLabel = `${clauseScroll.amount}px`;
        steps.push({
          id: randomUUID(),
          title: `Scroll ${clauseScroll.direction}`,
          intent: plannerOutput,
          action: {
            id: randomUUID(),
            kind: "ui.scroll",
            target: "active-window",
            args: {
              direction: clauseScroll.direction,
              amount: String(clauseScroll.amount),
              deltaX: String(clauseScroll.deltaX),
              deltaY: String(clauseScroll.deltaY)
            },
            riskLevel: "green",
            preconditions: ["The target content area is visible"],
            successCheck: [`Content moved ${clauseScroll.direction} by roughly ${amountLabel}`]
          },
          fallback: ["Retry with a smaller scroll amount", "Click the target pane first and retry"],
          successCriteria: [`Scroll ${clauseScroll.direction} by ${amountLabel}`]
        });
      }
    }

    if (!hasExplicitOpenStep && referencedApp && !activeAppMatches) {
      const appKey = this.normalizeApplicationToken(referencedApp);
      if (!openedApps.has(appKey)) {
        steps.unshift({
          id: randomUUID(),
          title: `Open ${referencedApp}`,
          intent: plannerOutput,
          action: {
            id: randomUUID(),
            kind: "ui.open_app",
            target: referencedApp,
            args: {
              app: referencedApp,
              text
            },
            riskLevel: "green",
            preconditions: [],
            successCheck: [`${referencedApp} is active`]
          },
          fallback: ["Try activating an existing app window", "Ask the user to open the app manually"],
          successCriteria: [`${referencedApp} is visible`]
        });
      }
    }

    return steps;
  }

  private shouldUseApplicationDiscovery(text: string) {
    return /(open|launch|start|activate|打开|启动|运行|切换到|进入)/i.test(text);
  }

  private shouldNormalizeApplicationRequest(text: string) {
    if (!this.shouldUseApplicationDiscovery(text)) {
      return false;
    }
    if (this.matchesChatIntent(text)) {
      return false;
    }
    if (/(窗口|window|标签页|tab)/i.test(text)) {
      return false;
    }
    if (
      /(?:然后|接着|随后|之后|并且|and then|then|after that|click|点击|输入|type|hotkey|按下|滚动|scroll|发送|send|上传|upload|删除|delete|编辑|edit|回复|reply|contact|联系人)/i.test(
        text
      )
    ) {
      return false;
    }
    return this.splitInstructionClauses(text).length <= 1;
  }

  private extractApplicationHint(text: string) {
    const quotedToken = /(?:open|launch|start|activate|打开|启动|运行|切换到|进入)\s*[“"']([^“"']{1,80})[”"']/i;
    const unquotedToken =
      /(?:open|launch|start|activate|打开|启动|运行|切换到|进入)\s+([^\n,，。:：]{1,80}?)(?=\s*(?:然后|接着|随后|之后|并且|and then|then|after that|click|点击|输入|type|hotkey|按下|滚动|scroll|$))/i;
    const quoted =
      text.match(quotedToken)?.[1] ??
      text.match(unquotedToken)?.[1];
    const normalized = quoted
      ?.trim()
      .replace(/[。！!?,，]+$/g, "")
      .replace(/\s*(?:app|application|应用|软件|程序)$/i, "")
      .trim();
    if (!normalized) {
      return undefined;
    }

    if (/^(app|application|应用|软件|program)$/i.test(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private resolveKnownApplicationFromHint(hint: string) {
    const normalizedHint = this.normalizeApplicationTokenForVerification(hint);
    if (!normalizedHint) {
      return undefined;
    }

    const knownApplications = getKnownApplications().map((entry) => resolveApplicationAlias(entry));
    const exactKnown = knownApplications.find(
      (entry) => this.normalizeApplicationTokenForVerification(entry) === normalizedHint
    );
    if (exactKnown) {
      return exactKnown;
    }

    const aliasedHint = resolveApplicationAlias(hint);
    if (this.normalizeApplicationTokenForVerification(aliasedHint) !== normalizedHint) {
      return aliasedHint;
    }

    return undefined;
  }

  private applicationHintMatchesAppName(hint: string, appName: string) {
    return this.normalizeApplicationToken(hint) === this.normalizeApplicationToken(appName);
  }

  private normalizeApplicationToken(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");
  }

  private createGenericChatPlugin(appName: string): ChatPluginInstance {
    const normalizedId = appName.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "app";
    return {
      id: `generic-${normalizedId}`,
      appName,
      aliases: [],
      capabilities: [...GENERIC_CHAT_PLUGIN_CAPABILITIES],
      channel: "chat-app",
      enabled: true,
      strategy: {
        attachmentButtonLabels: [...GENERIC_CHAT_PLUGIN_STRATEGY.attachmentButtonLabels],
        composerLabels: [...GENERIC_CHAT_PLUGIN_STRATEGY.composerLabels],
        contactSearchLabels: [...GENERIC_CHAT_PLUGIN_STRATEGY.contactSearchLabels],
        sendButtonLabels: [...GENERIC_CHAT_PLUGIN_STRATEGY.sendButtonLabels]
      }
    };
  }

  private isKnownChatApplication(appName: string) {
    const normalized = appName.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return getChatPluginApplications()
      .map((entry) => entry.trim().toLowerCase())
      .some((entry) => entry === normalized);
  }

  private matchesChatIntent(text: string) {
    if (/(消息|message|聊天|chat|联系人|contact|会话|conversation|私信|dm)/i.test(text)) {
      return true;
    }

    const hasOutboundVerb = /(发送|发消息|reply|回复|发文件|send file|upload|上传)/i.test(text);
    if (!hasOutboundVerb) {
      return false;
    }

    return /(?:给|发给|发送给|上传给|to\s+|contact\s+|@)/i.test(text);
  }

  private shouldTreatAsFileTransfer(text: string) {
    if (/(上传|upload|发送文件|发文件|send file|share file|传文件|附件|attach(?:ment)? file)/i.test(text)) {
      return true;
    }

    const hasFileArtifact =
      /(文件|文档|附件|document|file|pdf|docx?|xlsx?|pptx?|图片|照片|截图|压缩包|zip|rar)/i.test(text);
    if (!hasFileArtifact) {
      return false;
    }

    const hasTransferVerb = /(发送|发给|传给|给.*发|分享|share|send|upload|传输)/i.test(text);
    const hasRecipient = /(?:给|发给|发送给|上传给|to\s+|contact\s+|@)/i.test(text);
    return hasTransferVerb && hasRecipient;
  }

  private extractContactTarget(text: string) {
    const direct =
      text.match(/(?:给|发给|发送给)\s*[“"']?([^“"'\n,，。:：]{1,60})[”"']?/i)?.[1] ??
      text.match(/(?:to|contact)\s+[“"']?([^“"'\n,，。:：]{1,40})[”"']?/i)?.[1] ??
      text.match(/(?:切换到|进入|打开(?:与)?|和)\s*[“"']?([^“"'\n,，。:：]{1,40})[”"']?\s*(?:聊天|对话|会话|联系人)/i)?.[1] ??
      text.match(/(?:chat with|switch to|open chat with)\s+[“"']?([^“"'\n,，。:：]{1,40})[”"']?/i)?.[1];

    return direct?.trim();
  }

  private normalizeContactTarget(
    rawContact: string,
    context?: {
      aliases?: string[];
      appName?: string;
      referencedApp?: string;
    }
  ) {
    let contact = rawContact
      .trim()
      .replace(/^[“"']+|[”"']+$/g, "")
      .replace(/[。！!?,，:：]+$/g, "")
      .trim();
    if (!contact) {
      return rawContact.trim();
    }

    const prefixCandidates = new Set<string>();
    const pushCandidate = (value?: string) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return;
      }
      prefixCandidates.add(trimmed);
    };

    pushCandidate(context?.appName);
    pushCandidate(context?.referencedApp);
    for (const alias of context?.aliases ?? []) {
      pushCandidate(alias);
    }

    for (const appName of getChatPluginApplications()) {
      pushCandidate(appName);
    }

    for (const plugin of this.options.chatPlugins ?? []) {
      pushCandidate(plugin.appName);
      for (const alias of plugin.aliases) {
        pushCandidate(alias);
      }
    }

    const removePrefix = (value: string, prefix: string) => {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`^${escaped}(?:\\s*[-:：/|·•]*\\s*)?`, "i");
      if (!regex.test(value)) {
        return value;
      }
      const stripped = value.replace(regex, "").trim();
      return stripped || value;
    };

    const orderedPrefixes = Array.from(prefixCandidates).sort((left, right) => right.length - left.length);
    for (const prefix of orderedPrefixes) {
      const prefixKey = this.normalizeEntityToken(prefix);
      const contactKey = this.normalizeEntityToken(contact);
      if (!prefixKey || !contactKey || contactKey === prefixKey) {
        continue;
      }
      contact = removePrefix(contact, prefix);
    }

    contact = contact
      .replace(/^(?:联系人|contact|chat|会话|聊天|对话)\s*/i, "")
      .replace(/\s*(?:联系人|contact|chat|会话|聊天|对话)$/i, "")
      .replace(/\s*(?:发消息|发送消息|消息|reply|send(?:\s+message)?|聊天|chat|对话|会话)\s*$/i, "")
      .trim();

    return contact || rawContact.trim();
  }

  private extractFilePath(text: string) {
    const quotedSegments = [...text.matchAll(/[“"']([^“"']{2,260})[”"']/g)].map((segment) => segment[1]?.trim() ?? "");
    const hinted = quotedSegments.find((segment) => /[\\/]|\.([a-z0-9]{1,8})$/i.test(segment));
    if (hinted) {
      return hinted;
    }

    return text.match(/((?:\/|~\/|\.\/)[^\s,，。]{2,260})/i)?.[1]?.trim();
  }

  private resolveLabelFromStrategy(
    observation: DesktopObservation | undefined,
    labels: string[],
    preferredRole?: string
  ) {
    for (const label of labels) {
      const candidate = this.findCandidateByLabel(observation, label, preferredRole);
      if (candidate?.label) {
        return candidate.label;
      }
    }

    return labels[0];
  }

  private buildChatPluginPlan(params: {
    activeAppMatches: boolean;
    observation: DesktopObservation | undefined;
    plannerOutput: string;
    plugin: ChatPluginInstance;
    referencedApp: string | undefined;
    text: string;
  }) {
    const { activeAppMatches, observation, plannerOutput, plugin, referencedApp, text } = params;
    const steps: TaskRun["plan"] = [];
    const contactHint = this.extractContactTarget(text);
    const contact = contactHint
      ? this.normalizeContactTarget(contactHint, {
          appName: plugin.appName,
          aliases: plugin.aliases,
          referencedApp
        })
      : "pending-contact";
    const draftText = this.extractTypedText(text);
    const filePath = this.extractFilePath(text) ?? "pending-file";
    const wantsUpload = this.shouldTreatAsFileTransfer(text);
    const wantsSendMessage =
      !wantsUpload &&
      (/(发送|发|send|reply|回复)/i.test(text) || (Boolean(draftText) && /(消息|message|聊天|chat)/i.test(text)));
    const needsContact = wantsSendMessage || wantsUpload || /(联系人|contact|聊天|chat|对话)/i.test(text);
    const composerLabel = this.resolveLabelFromStrategy(observation, plugin.strategy.composerLabels, "text field");
    const attachmentLabel = this.resolveLabelFromStrategy(observation, plugin.strategy.attachmentButtonLabels, "button");

    if (referencedApp && !activeAppMatches) {
      steps.push({
        id: randomUUID(),
        title: `Open ${referencedApp}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.open_app",
          target: referencedApp,
          args: {
            app: referencedApp,
            text
          },
          riskLevel: "green",
          preconditions: [],
          successCheck: [`${referencedApp} is active`]
        },
        fallback: ["Try activating an existing app window", "Ask the user to open the app manually"],
        successCriteria: [`${referencedApp} is visible`]
      });
    }

    if (needsContact) {
      steps.push({
        id: randomUUID(),
        title: `Select contact ${contact}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "external.select_contact",
          target: contact,
          args: {
            app: plugin.appName,
            contact,
            searchLabelHints: plugin.strategy.contactSearchLabels.join(",")
          },
          riskLevel: "yellow",
          preconditions: ["Contact search results are visible"],
          successCheck: ["Chat header matches the selected contact"]
        },
        fallback: ["Search with an alternate alias", "Ask the user to confirm the contact"],
        successCriteria: [`${contact} chat context is visible`]
      });
    }

    if (draftText && composerLabel) {
      steps.push({
        id: randomUUID(),
        title: `Draft message in ${composerLabel}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.type_into_target",
          target: composerLabel,
          args: {
            app: plugin.appName,
            label: composerLabel,
            role: "text field",
            text: draftText
          },
          riskLevel: "green",
          preconditions: ["Message composer is visible"],
          successCheck: ["Composer contains the draft text"]
        },
        fallback: ["Focus the message composer and retry", "Ask user to confirm the active chat pane"],
        successCriteria: ["Message draft is prepared"]
      });
    }

    if (wantsUpload && attachmentLabel) {
      steps.push({
        id: randomUUID(),
        title: `Open attachment menu via ${attachmentLabel}`,
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "ui.click_target",
          target: attachmentLabel,
          args: {
            app: plugin.appName,
            label: attachmentLabel,
            role: "button"
          },
          riskLevel: "green",
          preconditions: ["Chat toolbar is visible"],
          successCheck: ["Attachment chooser is opened"]
        },
        fallback: ["Retry using alternate attachment label hints", "Ask user to open the attachment menu manually"],
        successCriteria: ["Attachment chooser is ready"]
      });

      steps.push({
        id: randomUUID(),
        title: "Request upload approval",
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "external.upload_file",
          target: contact,
          args: {
            app: plugin.appName,
            contact,
            filePath,
            attachmentLabelHints: plugin.strategy.attachmentButtonLabels.join(",")
          },
          riskLevel: "yellow",
          preconditions: ["File path is confirmed", "Attachment flow is ready"],
          successCheck: ["Action requires a valid one-time approval token"]
        },
        fallback: ["Keep the file selected and ask the user to confirm manual upload"],
        successCriteria: ["Upload is executed only after explicit approval"]
      });
    }

    if (wantsSendMessage) {
      steps.push({
        id: randomUUID(),
        title: "Request send approval",
        intent: plannerOutput,
        action: {
          id: randomUUID(),
          kind: "external.send_message",
          target: contact,
          args: {
            app: plugin.appName,
            contact,
            message: draftText ?? "",
            sendLabelHints: plugin.strategy.sendButtonLabels.join(",")
          },
          riskLevel: "red",
          preconditions: ["Draft text is verified", "Recipient is verified"],
          successCheck: ["Action requires explicit redline block handling"]
        },
        fallback: ["Keep draft in composer and ask the user to send manually"],
        successCriteria: ["Send remains blocked by policy redline"]
      });
    }

    return steps;
  }

  private extractClickTarget(text: string, observation?: DesktopObservation) {
    const candidateLabels = observation?.candidates.map((candidate) => candidate.label).filter(Boolean) ?? [];
    const normalizedText = text.trim();

    for (const label of candidateLabels) {
      if (label.length > 1 && normalizedText.toLowerCase().includes(label.toLowerCase())) {
        return label;
      }
    }

    const quoted =
      normalizedText.match(/[“"']([^“"']{1,40})[”"']/)?.[1] ??
      normalizedText.match(/(?:点击|点开|click|tap)\s+([^\n,，。]{1,40})/i)?.[1];

    return quoted?.trim();
  }

  private extractInputTarget(text: string, observation?: DesktopObservation) {
    if (!/(输入|键入|填写|type|paste)/i.test(text)) {
      return undefined;
    }

    const candidateLabels = observation?.candidates.map((candidate) => candidate.label).filter(Boolean) ?? [];
    const normalizedText = text.trim();

    for (const label of candidateLabels) {
      if (label.length > 1 && normalizedText.toLowerCase().includes(label.toLowerCase())) {
        return label;
      }
    }

    const quotedAfterInto =
      normalizedText.match(/(?:在|into|in)\s*[“"']?([^“"'\n]{1,40})[”"']?\s*(?:输入|键入|填写|type|paste)/i)?.[1] ??
      normalizedText.match(/(?:输入到|type into|paste into)\s*[“"']?([^“"'\n]{1,40})[”"']?/i)?.[1];

    return quotedAfterInto?.trim();
  }

  private extractExplicitClickHint(text: string) {
    const normalizedText = text.trim();
    if (!/(点击|点开|click|tap)/i.test(normalizedText)) {
      return undefined;
    }
    const quoted =
      normalizedText.match(/(?:点击|点开|click|tap)\s*[“"']([^“"']{1,60})[”"']/i)?.[1] ??
      normalizedText.match(/(?:点击|点开|click|tap)\s+([^\n,，。]{1,60})/i)?.[1];
    return quoted?.trim();
  }

  private extractExplicitInputHint(text: string) {
    const normalizedText = text.trim();
    if (!/(输入|键入|填写|type|paste)/i.test(normalizedText)) {
      return undefined;
    }

    const target =
      normalizedText.match(/(?:在|into|in)\s*[“"']?([^“"'\n]{1,40})[”"']?\s*(?:输入|键入|填写|type|paste)/i)?.[1] ??
      normalizedText.match(/(?:输入到|type into|paste into)\s*[“"']?([^“"'\n]{1,40})[”"']?/i)?.[1];

    return target?.trim();
  }

  private extractMenuTargetHint(text: string) {
    const normalizedText = text.trim();
    if (!/(菜单|menu|选项|item|选择|choose|select)/i.test(normalizedText)) {
      return undefined;
    }

    const target =
      normalizedText.match(/(?:菜单|menu|选项|item)\s*[“"']([^“"']{1,80})[”"']/i)?.[1] ??
      normalizedText.match(/(?:点击|选择|choose|select)\s*(?:菜单|menu|选项|item)\s*[“"']?([^“"'\n]{1,80})[”"']?/i)?.[1];

    const normalized = target?.trim();
    if (!normalized || /^(菜单|menu|选项|item)$/i.test(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private extractSemanticFileHint(text: string) {
    const normalizedText = text.trim();
    if (!/(文件|文档|document|file|folder|目录|附件|upload|下载|download|编辑|修改|删除|移动|rename|重命名)/i.test(normalizedText)) {
      return undefined;
    }

    const explicitPath = this.extractFilePath(normalizedText);
    if (explicitPath && /^(?:\/|~\/|\.\/|[A-Za-z]:\\)/.test(explicitPath)) {
      return undefined;
    }

    const hint =
      normalizedText.match(
        /(?:把|将)\s*([^\n,，。:：]{1,160}?(?:文件|文档|document|file))\s*(?=(?:发送|发给|上传|分享|给|to\s+|contact\s+))/i
      )?.[1] ??
      normalizedText.match(
        /(?:找一下|找找|查一下|查找|搜索一下|搜索|定位一下|定位|find|search)?\s*([^\n,，。:：]{1,160}?(?:文件|文档|document|file))\s*(?=(?:在哪里|在哪|然后|接着|随后|之后|并且|并|再|发送|发给|上传|给|to\s+|contact\s+|$))/i
      )?.[1] ??
      normalizedText.match(/(?:文件|文档|document|file|folder|目录)\s*[“"']([^“"']{1,160})[”"']/i)?.[1] ??
      normalizedText.match(
        /(?:文件|文档|document|file|folder|目录)\s+([^\n,，。:：]{1,160}?)(?=\s*(?:在哪里|在哪|然后|接着|随后|之后|并且|并|再|发送|发给|上传|给|to\s+|contact\s+|$))/i
      )?.[1] ??
      (/(文件|文档|document|file|folder|目录|附件)/i.test(normalizedText)
        ? normalizedText.match(/[“"']([^“"']{1,160})[”"']/)?.[1]
        : undefined);

    const normalized = hint
      ?.trim()
      .replace(/\s*(?:在哪里|在哪儿|在哪裡|在哪里呢|在哪呢)$/i, "")
      .replace(/[。！!?,，]+$/g, "")
      .trim();
    if (!normalized) {
      return undefined;
    }

    if (/^(文件|文档|document|file|folder|目录|附件|当前文件|this file)$/i.test(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private extractWindowHint(text: string) {
    const normalizedText = text.trim();
    if (!/(窗口|window|标签页|tab)/i.test(normalizedText)) {
      return undefined;
    }

    const hint =
      normalizedText.match(
        /(?:切换到|打开|激活|focus|switch to|activate)\s*[“"']?([^“"'\n]{1,80})[”"']?\s*(?:窗口|window|标签页|tab)/i
      )?.[1] ??
      normalizedText.match(/(?:窗口|window|标签页|tab)\s*[“"']([^“"']{1,80})[”"']/i)?.[1];

    const normalized = hint
      ?.trim()
      .replace(/[。！!?,，]+$/g, "")
      .trim();
    if (!normalized) {
      return undefined;
    }

    if (/^(窗口|window|标签页|tab|当前窗口|current window)$/i.test(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private extractTypedText(text: string) {
    const explicitInputQuoted =
      text.match(/(?:输入|键入|填写|type|paste)\s*[“"']([^“"']{1,200})[”"']/i)?.[1] ??
      text.match(/(?:输入为|内容为|text is)\s*[“"']([^“"']{1,200})[”"']/i)?.[1];
    if (explicitInputQuoted) {
      return explicitInputQuoted.trim();
    }

    const quotedSegments = [...text.matchAll(/[“"']([^“"']{1,200})[”"']/g)];
    if (quotedSegments.length > 0 && /输入|键入|填写|type|paste/i.test(text)) {
      const verbIndex = text.search(/输入|键入|填写|type|paste/i);
      const quotedAfterVerb = quotedSegments.find((segment) => (segment.index ?? -1) > verbIndex)?.[1];
      if (quotedAfterVerb) {
        return quotedAfterVerb.trim();
      }

      return quotedSegments.at(-1)?.[1]?.trim();
    }

    const typed =
      text.match(/(?:输入|键入|填写)\s*[:：]?\s*([^\n]{1,200})/i)?.[1] ??
      text.match(/(?:type|paste)\s+([^\n]{1,200})/i)?.[1];

    return typed?.trim();
  }

  private extractHotkeyCombo(text: string) {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return undefined;
    }

    const directCombo =
      normalizedText.match(
        /(?:⌘|cmd|command|ctrl|control|alt|option|shift)\s*(?:\+\s*[a-z0-9]+(?:\s*\+\s*[a-z0-9]+)*)/i
      )?.[0] ??
      normalizedText.match(
        /(?:快捷键|hotkey|按下|press|按)\s*[:：]?\s*([^\n,，。]{1,80})/i
      )?.[1];
    if (directCombo) {
      const normalizedCombo = this.normalizeHotkeyCombo(directCombo);
      if (normalizedCombo) {
        return normalizedCombo;
      }
    }

    const namedKey =
      normalizedText.match(/(?:按下|press|按)\s*(回车|enter|return|esc|escape|tab|space|空格|上箭头|下箭头|左箭头|右箭头)/i)?.[1];
    if (!namedKey) {
      return undefined;
    }

    return this.normalizeHotkeyToken(namedKey);
  }

  private normalizeHotkeyCombo(raw: string) {
    const compact = raw
      .trim()
      .replace(/快捷键|hotkey|press|按下|按|key|键/gi, "")
      .trim();
    if (!compact) {
      return undefined;
    }

    const parts = compact.includes("+")
      ? compact.split("+")
      : compact.split(/\s+/);
    const normalizedTokens = parts
      .map((token) => this.normalizeHotkeyToken(token))
      .filter((token): token is string => Boolean(token));
    if (normalizedTokens.length === 0) {
      return undefined;
    }

    const primary = normalizedTokens.at(-1);
    if (!primary || !this.isPrimaryHotkeyToken(primary)) {
      return undefined;
    }

    const modifiers = normalizedTokens.slice(0, -1).filter((token) => this.isModifierHotkeyToken(token));
    const uniqueModifiers = Array.from(new Set(modifiers));
    return [...uniqueModifiers, primary].join("+");
  }

  private normalizeHotkeyToken(raw: string) {
    const token = raw
      .trim()
      .toLowerCase()
      .replace(/[()]/g, "");
    if (!token) {
      return undefined;
    }

    if (["⌘", "cmd", "command", "meta"].includes(token)) {
      return "cmd";
    }

    if (["ctrl", "control", "^"].includes(token) || /控制/.test(token)) {
      return "ctrl";
    }

    if (["alt", "option", "opt", "⌥"].includes(token) || /选项/.test(token)) {
      return "alt";
    }

    if (["shift", "⇧"].includes(token)) {
      return "shift";
    }

    if (["return", "enter"].includes(token) || /回车|确认/.test(token)) {
      return "enter";
    }

    if (["esc", "escape"].includes(token)) {
      return "esc";
    }

    if (["tab", "space"].includes(token) || /空格/.test(token)) {
      return token === "space" || /空格/.test(token) ? "space" : "tab";
    }

    if (["up", "down", "left", "right"].includes(token) || /上箭头|下箭头|左箭头|右箭头/.test(token)) {
      if (token.includes("up") || /上箭头/.test(token)) {
        return "up";
      }
      if (token.includes("down") || /下箭头/.test(token)) {
        return "down";
      }
      if (token.includes("left") || /左箭头/.test(token)) {
        return "left";
      }
      if (token.includes("right") || /右箭头/.test(token)) {
        return "right";
      }
    }

    if (["delete", "backspace"].includes(token) || /删除|退格/.test(token)) {
      return token === "backspace" || /退格/.test(token) ? "backspace" : "delete";
    }

    if (/^[a-z0-9]$/.test(token)) {
      return token;
    }

    return undefined;
  }

  private isModifierHotkeyToken(token: string) {
    return ["cmd", "ctrl", "alt", "shift"].includes(token);
  }

  private isPrimaryHotkeyToken(token: string) {
    return (
      /^[a-z0-9]$/.test(token) ||
      ["enter", "tab", "space", "esc", "up", "down", "left", "right", "delete", "backspace"].includes(token)
    );
  }

  private extractScrollRequest(text: string) {
    if (!/(滚动|scroll|上滑|下滑|向上|向下|向左|向右|scroll up|scroll down|scroll left|scroll right)/i.test(text)) {
      return undefined;
    }

    const amountMatch = text.match(/(?:滚动|scroll|向上|向下|向左|向右|上滑|下滑)\D{0,8}(\d{1,4})\s*(?:px|pixels|行|line)?/i)?.[1];
    const parsedAmount = amountMatch ? Number.parseInt(amountMatch, 10) : 320;
    const amount = Math.min(Math.max(Number.isFinite(parsedAmount) ? parsedAmount : 320, 40), 2000);

    let direction: "up" | "down" | "left" | "right" = "down";
    if (/(向上|上滑|scroll up|up)/i.test(text)) {
      direction = "up";
    } else if (/(向左|左滑|scroll left|left)/i.test(text)) {
      direction = "left";
    } else if (/(向右|右滑|scroll right|right)/i.test(text)) {
      direction = "right";
    } else if (/(向下|下滑|scroll down|down)/i.test(text)) {
      direction = "down";
    }

    return {
      direction,
      amount,
      deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0,
      deltaY: direction === "up" ? amount : direction === "down" ? -amount : 0
    };
  }

  private isDangerousTarget(targetLabel: string | undefined) {
    if (!targetLabel) {
      return false;
    }

    return /^(发送|send|上传|upload|删除|delete|付款|pay|提交|submit)$/i.test(targetLabel.trim());
  }

  private async refineVerificationWithVision(
    action: DesktopAction,
    before: DesktopObservation | undefined,
    after: DesktopObservation,
    base: VerificationResult
  ): Promise<VerificationResult> {
    if (base.status === "verified") {
      return base;
    }

    if (!this.shouldAttemptVisionVerification(action, after)) {
      return base;
    }

    try {
      const raw = await this.modelRouter.promptWithImage("vision", {
        imagePath: after.screenshotPath!,
        text: buildVisionVerificationPrompt({
          action,
          before,
          after,
          base,
          focusedElementSummary: this.serializeObservationElement(after.focusedElement),
          candidateSummaries: after.candidates
            .slice(0, 12)
            .map((candidate) => this.serializeObservationElement(candidate))
            .filter(Boolean),
          recentEventKinds: after.recentEvents?.map((event) => event.kind) ?? [],
          textSummary:
            (typeof action.args.text === "string" && action.args.text.trim()) ||
            (typeof action.args.value === "string" && action.args.value.trim()) ||
            undefined
        }),
        system: buildVisionVerificationSystemPrompt()
      });
      const candidate = this.parseVisionVerification(raw);
      if (!candidate) {
        return base;
      }

      if (candidate.status === "verified" && candidate.confidence >= 0.72) {
        return this.verificationVerified(
          candidate.message,
          [
            ...base.evidence,
            `vision:${candidate.confidence.toFixed(2)}`,
            ...(after.screenshotRef ? [`screenshotRef=${after.screenshotRef}`] : [])
          ],
          [
            ...base.evidenceItems,
            {
              source: "vision",
              kind: "verdict",
              message: candidate.message,
              confidence: candidate.confidence,
              screenshotRef: after.screenshotRef
            }
          ]
        );
      }

      if (candidate.status === "failed" && candidate.confidence >= 0.8) {
        return this.verificationFailed(
          candidate.message,
          [
            ...base.evidence,
            `vision:${candidate.confidence.toFixed(2)}`,
            ...(after.screenshotRef ? [`screenshotRef=${after.screenshotRef}`] : [])
          ],
          [
            ...base.evidenceItems,
            {
              source: "vision",
              kind: "verdict",
              message: candidate.message,
              confidence: candidate.confidence,
              screenshotRef: after.screenshotRef
            }
          ]
        );
      }

      if (base.status === "failed" && candidate.status === "dispatched_unverified" && candidate.confidence >= 0.6) {
        return this.verificationUnverified(
          candidate.message,
          [
            ...base.evidence,
            `vision:${candidate.confidence.toFixed(2)}`,
            ...(after.screenshotRef ? [`screenshotRef=${after.screenshotRef}`] : [])
          ],
          [
            ...base.evidenceItems,
            {
              source: "vision",
              kind: "verdict",
              message: candidate.message,
              confidence: candidate.confidence,
              screenshotRef: after.screenshotRef
            }
          ]
        );
      }
    } catch {
      return base;
    }

    return base;
  }

  private shouldAttemptVisionVerification(action: DesktopAction, observation: DesktopObservation) {
    if (!observation.screenshotPath) {
      return false;
    }

    const supportedActionKinds = new Set([
      "ui.open_app",
      "ui.activate_app",
      "ui.focus_target",
      "ui.click_target",
      "ui.type_into_target",
      "ui.type_text",
      "ui.paste_text",
      "ui.hotkey",
      "ui.scroll",
      "ui.edit_existing",
      "external.select_contact",
      "external.upload_file"
    ]);
    return supportedActionKinds.has(action.kind);
  }

  private parseVisionVerification(raw: string) {
    if (!raw || /^\[stub:[^\]]+\]/.test(raw.trim())) {
      return undefined;
    }

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(match[0]) as {
        confidence?: number;
        message?: string;
        status?: string;
      };
      if (!parsed || typeof parsed.message !== "string" || typeof parsed.status !== "string") {
        return undefined;
      }
      if (!["verified", "dispatched_unverified", "failed"].includes(parsed.status)) {
        return undefined;
      }

      return {
        confidence:
          typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
            ? Math.min(Math.max(parsed.confidence, 0), 1)
            : 0.5,
        message: parsed.message.trim(),
        status: parsed.status as VerificationResult["status"]
      };
    } catch {
      return undefined;
    }
  }

  private verifyActionOutcome(
    action: DesktopAction,
    before: DesktopObservation | undefined,
    after: DesktopObservation,
    executionReport?: string
  ): VerificationResult {
    switch (action.kind) {
      case "ui.open_app":
      case "ui.activate_app": {
        const rawApplicationName = this.resolveApplicationTarget(action);
        if (!rawApplicationName) {
          if (this.isMissingAppMatchExecution(executionReport)) {
            return this.verificationFailed(
              `${action.kind} could not resolve a concrete application target. Please specify the app name explicitly.`
            );
          }
          return this.verificationUnverified(`${action.kind} executed without an explicit application target.`);
        }
        const applicationName = this.canonicalizeApplicationName(rawApplicationName);

        const appIsActive = this.isApplicationVisibleInObservation(applicationName, after);
        if (appIsActive) {
          return this.verificationVerified(`${applicationName} is visible after ${action.kind}.`, [
            `activeApp=${after.activeApp}`,
            `activeWindow=${after.activeWindowTitle ?? "unknown"}`
          ]);
        }

        if (this.isLaunchAcknowledgedByBridge(action.kind, applicationName, executionReport)) {
          return this.verificationVerified(
            `Bridge acknowledged ${action.kind} for ${applicationName}; snapshot visibility check was inconclusive.`,
            [`bridge=${executionReport ?? "acknowledged"}`]
          );
        }

        if (this.observationIncludesText(after, applicationName)) {
          return this.verificationVerified(`${applicationName} appears in OCR text after ${action.kind}.`, [
            `ocr=${applicationName}`
          ]);
        }

        return this.verificationFailed(`${applicationName} did not become visible after ${action.kind}.`, [
          `activeApp=${after.activeApp}`,
          `windows=${after.windows.join(", ")}`
        ]);
      }
      case "ui.focus_target":
      case "ui.click_target": {
        const targetLabel = this.resolveActionTargetLabel(action);
        const targetRole = this.resolveActionRole(action);
        if (!targetLabel) {
          return this.verificationUnverified(`${action.kind} executed without a semantic target label.`);
        }

        if (this.focusedElementMatches(after, targetLabel, targetRole)) {
          return this.verificationVerified(`Focused element now matches "${targetLabel}" after ${action.kind}.`, [
            `focused=${after.focusedElement?.label ?? after.focusedElement?.id ?? "unknown"}`
          ]);
        }

        const candidate = this.findCandidateByLabel(after, targetLabel, targetRole);
        if (candidate?.focused) {
          return this.verificationVerified(`Target "${targetLabel}" is focused after ${action.kind}.`, [
            `candidate=${candidate.label}`
          ]);
        }

        const windowChanged =
          before?.activeWindowTitle &&
          after.activeWindowTitle &&
          before.activeWindowTitle !== after.activeWindowTitle;
        if (windowChanged) {
          return this.verificationVerified(`Window context changed after interacting with "${targetLabel}".`, [
            `before=${before?.activeWindowTitle ?? "unknown"}`,
            `after=${after.activeWindowTitle ?? "unknown"}`
          ]);
        }

        const focusEvent = this.findObservationEvent(after, ["focus.changed", "window.changed", "selection.changed"]);
        if (focusEvent) {
          return this.verificationVerified(`Observed ${focusEvent.kind} after interacting with "${targetLabel}".`, [
            focusEvent.message
          ]);
        }

        return this.verificationFailed(
          `Target "${targetLabel}" was not focused and no window change was observed after ${action.kind}.`
        );
      }
      case "ui.type_into_target": {
        const targetLabel = this.resolveActionTargetLabel(action);
        const targetRole = this.resolveActionRole(action);
        const text = this.resolveActionText(action);
        if (!targetLabel || !text) {
          return this.verificationUnverified(`${action.kind} executed without enough semantic data to verify.`);
        }

        const candidate = this.findCandidateByLabel(after, targetLabel, targetRole);
        const focusedValue = after.focusedElement?.value;
        if (focusedValue?.includes(text)) {
          return this.verificationVerified(
            `Focused element now contains the requested text for "${targetLabel}".`,
            [`focusedValue=${focusedValue}`]
          );
        }

        if (candidate?.value?.includes(text)) {
          return this.verificationVerified(`Target "${targetLabel}" now contains the requested text.`, [
            `candidateValue=${candidate.value}`
          ]);
        }

        const valueEvent = this.findObservationEvent(after, ["value.changed"]);
        if (valueEvent) {
          return this.verificationVerified(
            `Observed value change after typing into "${targetLabel}", although the exact text was not readable.`,
            [valueEvent.message]
          );
        }

        if (this.observationIncludesText(after, text) || this.observationIncludesText(after, targetLabel)) {
          return this.verificationVerified(
            `OCR text suggests the requested input for "${targetLabel}" is now visible.`
          );
        }

        return this.verificationFailed(`Target "${targetLabel}" does not show the requested text after input.`);
      }
      case "ui.type_text":
      case "ui.paste_text": {
        const text = this.resolveActionText(action);
        if (!text) {
          return this.verificationUnverified(`${action.kind} executed without explicit text content to verify.`);
        }

        const focusedCandidate = after.candidates.find((candidate) => candidate.focused && candidate.value?.includes(text));
        const anyCandidate = after.candidates.find((candidate) => candidate.value?.includes(text));
        if (after.focusedElement?.value?.includes(text) || focusedCandidate || anyCandidate) {
          return this.verificationVerified("The requested text is visible in the post-action observation.", [
            `focused=${after.focusedElement?.label ?? "unknown"}`
          ]);
        }

        const valueEvent = this.findObservationEvent(after, ["value.changed"]);
        if (valueEvent) {
          return this.verificationVerified(
            "Observed a value-change event after text input, although the exact text was not readable.",
            [valueEvent.message]
          );
        }

        if (this.observationIncludesText(after, text)) {
          return this.verificationVerified("OCR text suggests the requested text is visible after input.");
        }

        return this.verificationFailed("The requested text is not visible in any post-action input candidate.");
      }
      case "external.select_contact": {
        const contact = this.resolveActionContactName(action);
        if (!contact) {
          return this.verificationFailed(
            "Contact target is missing for external.select_contact. Provide an explicit contact name."
          );
        }

        const contactVisibleByWindow = [
          after.activeWindowTitle ?? "",
          ...after.windows
        ].some((value) => value.toLowerCase().includes(contact.toLowerCase()));
        const contactCandidate = this.findCandidateByLabel(after, contact);
        if (contactVisibleByWindow || contactCandidate?.focused || Boolean(contactCandidate)) {
          return this.verificationVerified(`Contact "${contact}" appears selected in post-action observation.`, [
            `activeWindow=${after.activeWindowTitle ?? "unknown"}`
          ]);
        }

        if (this.observationIncludesText(after, contact)) {
          return this.verificationVerified(`OCR text suggests contact "${contact}" is visible after selection.`);
        }

        if (this.isContactSelectionAcknowledgedByBridge(contact, executionReport)) {
          return this.verificationUnverified(
            `Bridge acknowledged external.select_contact for "${contact}", but the UI selection still needs confirmation.`,
            [`bridge=${executionReport ?? "acknowledged"}`]
          );
        }

        return this.verificationFailed(`Contact "${contact}" is not visible after contact selection.`);
      }
      case "external.upload_file": {
        const filePath = this.resolveActionFilePath(action);
        const normalizedReport = executionReport?.trim().toLowerCase() ?? "";

        if (normalizedReport.startsWith("uploaded-file:")) {
          return this.verificationUnverified(
            filePath
              ? `File "${filePath}" upload was dispatched after approval, but the UI still needs confirmation.`
              : "File upload was dispatched after approval, but the UI still needs confirmation.",
            [`bridge=${executionReport ?? normalizedReport}`]
          );
        }

        if (normalizedReport === "stubbed:external.upload_file") {
          return this.verificationUnverified("Upload action was dispatched by stub bridge (dry-run).", [
            "bridge=stubbed"
          ]);
        }

        if (normalizedReport.startsWith("noop:file-not-found")) {
          return this.verificationFailed(
            filePath ? `File "${filePath}" was not found on disk.` : "Upload target file was not found on disk."
          );
        }

        if (normalizedReport.startsWith("noop:file-picker-not-ready")) {
          return this.verificationFailed("File picker is not ready. Open attachment/file chooser first, then retry.");
        }

        if (normalizedReport.startsWith("noop:no-file-path")) {
          return this.verificationFailed(
            "Upload action is missing file path. Provide an explicit file path or filename."
          );
        }

        const fileName = filePath?.split(/[\\/]/).at(-1)?.toLowerCase();
        const fileVisibleInObservation =
          Boolean(fileName) &&
          [
            after.activeWindowTitle ?? "",
            ...after.windows,
            ...after.candidates.flatMap((candidate) => [candidate.label, candidate.value ?? ""])
          ].some((value) => value.toLowerCase().includes(fileName!));
        if (fileVisibleInObservation) {
          return this.verificationVerified(
            filePath
              ? `File "${filePath}" is visible in the post-action observation.`
              : "Selected upload file is visible in the post-action observation.",
            [`activeWindow=${after.activeWindowTitle ?? "unknown"}`]
          );
        }

        if (fileName && this.observationIncludesText(after, fileName)) {
          return this.verificationVerified(
            filePath
              ? `OCR text suggests file "${filePath}" is visible after upload preparation.`
              : "OCR text suggests the selected upload file is visible."
          );
        }

        return this.verificationUnverified(
          executionReport ? `Upload action executed: ${executionReport}` : "Upload action executed."
        );
      }
      case "ui.hotkey": {
        const keys =
          (typeof action.args.keys === "string" ? action.args.keys : undefined) ??
          (typeof action.args.hotkey === "string" ? action.args.hotkey : undefined);
        if (this.hasMeaningfulObservationDiff(before, after)) {
          return this.verificationVerified(
            keys ? `Hotkey "${keys}" dispatched and the desktop state changed.` : "Hotkey dispatched and the desktop state changed."
          );
        }

        const hotkeyEvent = this.findObservationEvent(after, ["window.changed", "focus.changed", "selection.changed"]);
        if (hotkeyEvent) {
          return this.verificationVerified(
            keys ? `Hotkey "${keys}" dispatched and generated ${hotkeyEvent.kind}.` : `Hotkey dispatched and generated ${hotkeyEvent.kind}.`,
            [hotkeyEvent.message]
          );
        }

        return this.verificationUnverified(
          keys
            ? `Hotkey "${keys}" dispatched, but post-action state was not directly verifiable. Confirm the desktop state before continuing.`
            : "Hotkey dispatched, but post-action state was not directly verifiable. Confirm the desktop state before continuing."
        );
      }
      case "ui.scroll": {
        const direction = typeof action.args.direction === "string" ? action.args.direction : "unknown";
        const amount = typeof action.args.amount === "string" ? action.args.amount : undefined;
        if (this.hasMeaningfulObservationDiff(before, after)) {
          return this.verificationVerified(
            amount
              ? `Scroll changed the observed desktop state (${direction}, amount=${amount}).`
              : `Scroll changed the observed desktop state (${direction}).`
          );
        }

        const scrollEvent = this.findObservationEvent(after, ["value.changed", "selection.changed", "window.changed"]);
        if (scrollEvent) {
          return this.verificationVerified(
            amount
              ? `Scroll triggered ${scrollEvent.kind} (${direction}, amount=${amount}).`
              : `Scroll triggered ${scrollEvent.kind} (${direction}).`,
            [scrollEvent.message]
          );
        }

        return this.verificationUnverified(
          amount
            ? `Scroll dispatched (${direction}, amount=${amount}), but post-action state was not directly verifiable. Confirm the desktop state before continuing.`
            : `Scroll dispatched (${direction}), but post-action state was not directly verifiable. Confirm the desktop state before continuing.`
        );
      }
      default:
        return this.hasMeaningfulObservationDiff(before, after)
          ? this.verificationVerified(`${action.kind} executed and changed the observed desktop state.`)
          : this.verificationUnverified(
              `${action.kind} executed, but the post-action desktop state was not directly verifiable.`
            );
    }
  }

  private async capturePostActionObservation(
    action: DesktopAction,
    before: DesktopObservation | undefined,
    executionReport?: string
  ) {
    const policy = this.settlePolicyForAction(action);
    let latestObservation: DesktopObservation | undefined;
    let latestVerification: VerificationResult | undefined;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      if (attempt > 1 && policy.retryDelayMs > 0) {
        await sleep(policy.retryDelayMs);
      }

      const observation = await this.bridgeClient.snapshot();
      const verification = this.verifyActionOutcome(action, before, observation, executionReport);
      latestObservation = observation;
      latestVerification = verification;

      if (!this.shouldRetryPostActionVerification(action, verification, before, observation, executionReport, attempt, policy.maxAttempts)) {
        return {
          observation,
          verification: this.withSettleEvidence(verification, observation, attempt)
        };
      }
    }

    return {
      observation: latestObservation!,
      verification: this.withSettleEvidence(latestVerification!, latestObservation!, policy.maxAttempts)
    };
  }

  private settlePolicyForAction(action: DesktopAction) {
    switch (action.kind) {
      case "ui.open_app":
      case "ui.activate_app":
      case "external.upload_file":
        return { maxAttempts: 3, retryDelayMs: 180 };
      case "ui.focus_target":
      case "ui.click_target":
      case "external.select_contact":
        return { maxAttempts: 3, retryDelayMs: 120 };
      case "ui.type_into_target":
      case "ui.type_text":
      case "ui.paste_text":
        return { maxAttempts: 3, retryDelayMs: 100 };
      case "ui.hotkey":
      case "ui.scroll":
        return { maxAttempts: 2, retryDelayMs: 120 };
      default:
        return { maxAttempts: 2, retryDelayMs: 80 };
    }
  }

  private shouldRetryPostActionVerification(
    action: DesktopAction,
    verification: VerificationResult,
    before: DesktopObservation | undefined,
    after: DesktopObservation,
    executionReport: string | undefined,
    attempt: number,
    maxAttempts: number
  ) {
    if (verification.status === "verified") {
      return false;
    }

    if (attempt >= maxAttempts) {
      return false;
    }

    if (this.isTerminalExecutionReport(executionReport)) {
      return false;
    }

    if (!this.isObservationFreshComparedTo(before, after)) {
      return true;
    }

    switch (action.kind) {
      case "ui.open_app":
      case "ui.activate_app":
      case "ui.focus_target":
      case "ui.click_target":
      case "ui.type_into_target":
      case "ui.type_text":
      case "ui.paste_text":
      case "external.select_contact":
      case "external.upload_file":
      case "ui.hotkey":
      case "ui.scroll":
        return true;
      default:
        return verification.status === "dispatched_unverified";
    }
  }

  private isObservationFreshComparedTo(before: DesktopObservation | undefined, after: DesktopObservation) {
    if (!before) {
      return true;
    }

    if (before.snapshotAt && after.snapshotAt) {
      return before.snapshotAt !== after.snapshotAt;
    }

    if (before.screenshotRef !== after.screenshotRef) {
      return true;
    }

    return this.hasMeaningfulObservationDiff(before, after);
  }

  private isTerminalExecutionReport(executionReport?: string) {
    const normalized = executionReport?.trim().toLowerCase() ?? "";
    return normalized.startsWith("noop:") || normalized.startsWith("error:");
  }

  private withSettleEvidence(
    verification: VerificationResult,
    observation: DesktopObservation,
    attempts: number
  ): VerificationResult {
    if (attempts <= 1) {
      return verification;
    }

    return {
      ...verification,
      evidenceItems: this.mergeEvidenceItems(verification.evidence, [
        ...verification.evidenceItems,
        {
          source: "local",
          kind: "settle_window",
          field: "settleAttempts",
          message: `Post-action verification settled after ${attempts} observations.`,
          value: String(attempts),
          screenshotRef: observation.screenshotRef
        }
      ])
    };
  }

  private verificationVerified(
    message: string,
    evidence: string[] = [],
    evidenceItems: VerificationEvidenceItem[] = []
  ): VerificationResult {
    return {
      status: "verified",
      message,
      evidence,
      evidenceItems: this.mergeEvidenceItems(evidence, evidenceItems)
    };
  }

  private verificationUnverified(
    message: string,
    evidence: string[] = [],
    evidenceItems: VerificationEvidenceItem[] = []
  ): VerificationResult {
    return {
      status: "dispatched_unverified",
      message,
      evidence,
      evidenceItems: this.mergeEvidenceItems(evidence, evidenceItems)
    };
  }

  private verificationFailed(
    message: string,
    evidence: string[] = [],
    evidenceItems: VerificationEvidenceItem[] = []
  ): VerificationResult {
    return {
      status: "failed",
      message,
      evidence,
      evidenceItems: this.mergeEvidenceItems(evidence, evidenceItems)
    };
  }

  private mergeEvidenceItems(evidence: string[], evidenceItems: VerificationEvidenceItem[]) {
    const merged = [
      ...evidence.map((entry) => this.parseEvidenceItem(entry)),
      ...evidenceItems
    ];

    const deduped = new Map<string, VerificationEvidenceItem>();
    for (const item of merged) {
      const key = [
        item.source,
        item.kind,
        item.field ?? "",
        item.value ?? "",
        item.screenshotRef ?? "",
        item.message
      ].join("|");
      if (!deduped.has(key)) {
        deduped.set(key, item);
      }
    }
    return [...deduped.values()];
  }

  private parseEvidenceItem(entry: string): VerificationEvidenceItem {
    const normalized = entry.trim();
    const [prefix, rawValue] = normalized.split("=", 2);
    if (prefix === "bridge") {
      return {
        source: "bridge",
        kind: "ack",
        field: "bridge",
        message: normalized,
        value: rawValue
      };
    }
    if (prefix === "ocr") {
      return {
        source: "ocr",
        kind: "text_match",
        field: "ocr",
        message: normalized,
        value: rawValue
      };
    }
    if (prefix === "activeApp" || prefix === "activeWindow" || prefix === "focused" || prefix === "candidate" || prefix === "focusedValue" || prefix === "candidateValue" || prefix === "before" || prefix === "after" || prefix === "windows") {
      return {
        source: "local",
        kind: "state",
        field: prefix,
        message: normalized,
        value: rawValue
      };
    }
    if (prefix === "screenshotRef") {
      return {
        source: "vision",
        kind: "screenshot",
        field: "screenshotRef",
        message: normalized,
        screenshotRef: rawValue,
        value: rawValue
      };
    }
    if (normalized.startsWith("vision:")) {
      const confidence = Number.parseFloat(normalized.slice("vision:".length));
      return {
        source: "vision",
        kind: "confidence",
        message: normalized,
        confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : undefined
      };
    }
    return {
      source: normalized.includes(".changed") ? "event" : "local",
      kind: normalized.includes(".changed") ? "event" : "note",
      message: normalized
    };
  }

  private resolveApplicationTarget(action: DesktopAction) {
    const placeholders = new Set(["pending-contact", "pending-target", "discovery", "active-window", "current-focus"]);
    const candidates = [
      typeof action.args.app === "string" ? action.args.app : undefined,
      typeof action.args.application === "string" ? action.args.application : undefined,
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

  private resolveActionTargetLabel(action: DesktopAction) {
    const candidates = [
      typeof action.args.label === "string" ? action.args.label : undefined,
      typeof action.args.targetLabel === "string" ? action.args.targetLabel : undefined,
      action.target
    ];

    return candidates.find((value) => value && value.trim().length > 0)?.trim();
  }

  private resolveActionText(action: DesktopAction) {
    const candidates = [
      typeof action.args.text === "string" ? action.args.text : undefined,
      typeof action.args.value === "string" ? action.args.value : undefined,
      typeof action.args.message === "string" ? action.args.message : undefined
    ];

    return candidates.find((value) => value && value.trim().length > 0)?.trim();
  }

  private resolveActionRole(action: DesktopAction) {
    return typeof action.args.role === "string" ? this.normalizeRoleName(action.args.role) : undefined;
  }

  private resolveActionContactName(action: DesktopAction) {
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

  private resolveActionFilePath(action: DesktopAction) {
    const placeholders = new Set(["pending-file", "pending-target", "discovery"]);
    const candidates = [
      typeof action.args.filePath === "string" ? action.args.filePath : undefined,
      typeof action.args.path === "string" ? action.args.path : undefined,
      typeof action.args.file === "string" ? action.args.file : undefined,
      typeof action.args.sourcePath === "string" ? action.args.sourcePath : undefined,
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

  private findCandidateByLabel(observation: DesktopObservation | undefined, label: string, preferredRole?: string) {
    if (!observation) {
      return undefined;
    }

    const normalizedTarget = this.normalize(label);
    const normalizedRole = this.normalizeRoleName(preferredRole);
    const roleMatchedExact = observation.candidates.find((candidate) => {
      const candidateRole = this.normalizeRoleName(candidate.role);
      return this.normalize(candidate.label) === normalizedTarget && this.roleMatches(candidateRole, normalizedRole);
    });
    if (roleMatchedExact) {
      return roleMatchedExact;
    }

    const roleMatchedContains = observation.candidates.find((candidate) => {
      const candidateRole = this.normalizeRoleName(candidate.role);
      return this.normalize(candidate.label).includes(normalizedTarget) && this.roleMatches(candidateRole, normalizedRole);
    });
    if (roleMatchedContains) {
      return roleMatchedContains;
    }

    return (
      observation.candidates.find((candidate) => this.normalize(candidate.label) === normalizedTarget) ??
      observation.candidates.find((candidate) => this.normalize(candidate.label).includes(normalizedTarget))
    );
  }

  private hydratePlanTargetDescriptors(plan: TaskRun["plan"], observation: DesktopObservation | undefined) {
    if (!observation) {
      return plan;
    }

    return plan.map((step) => ({
      ...step,
      action: this.hydrateActionTargetDescriptor(step.action, observation)
    }));
  }

  private hydrateActionTargetDescriptor(action: DesktopAction, observation: DesktopObservation) {
    if (this.extractTargetDescriptor(action)) {
      return action;
    }

    const label = this.resolveDescriptorLabel(action);
    if (!label) {
      return action;
    }

    const preferredRole =
      action.kind === "external.select_contact" ? undefined : this.resolveActionRole(action);
    const candidate = this.findCandidateByLabel(observation, label, preferredRole);
    if (!candidate) {
      return action;
    }

    const descriptor: TargetDescriptor = {
      candidateId: candidate.id,
      label: candidate.label,
      role: candidate.role,
      source: candidate.source,
      bounds: candidate.bounds,
      screenshotRef: observation.screenshotRef,
      snapshotAt: observation.snapshotAt
    };

    return {
      ...action,
      targetDescriptor: descriptor
    };
  }

  private resolveDescriptorLabel(action: DesktopAction) {
    switch (action.kind) {
      case "ui.focus_target":
      case "ui.click_target":
      case "ui.type_into_target":
        return this.resolveActionTargetLabel(action);
      case "external.select_contact":
        return this.resolveActionContactName(action);
      default:
        return undefined;
    }
  }

  private extractTargetDescriptor(action: DesktopAction) {
    return this.parseTargetDescriptor(action.targetDescriptor) ?? this.parseTargetDescriptor(action.args.targetDescriptor);
  }

  private parseTargetDescriptor(raw: unknown) {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }

    const candidateId = "candidateId" in raw && typeof raw.candidateId === "string" ? raw.candidateId : undefined;
    const label = "label" in raw && typeof raw.label === "string" ? raw.label : undefined;
    const sourceValue = "source" in raw && typeof raw.source === "string" ? raw.source : undefined;
    const source =
      sourceValue && ["ax", "ocr", "vision", "dom"].includes(sourceValue)
        ? (sourceValue as TargetDescriptor["source"])
        : undefined;
    if (!candidateId || !label || !source) {
      return undefined;
    }

    const boundsRecord =
      "bounds" in raw && raw.bounds && typeof raw.bounds === "object"
        ? (raw.bounds as Record<string, unknown>)
        : undefined;

    return {
      bounds:
        boundsRecord &&
        typeof boundsRecord.x === "number" &&
        typeof boundsRecord.y === "number" &&
        typeof boundsRecord.width === "number" &&
        typeof boundsRecord.height === "number"
          ? {
              x: boundsRecord.x,
              y: boundsRecord.y,
              width: boundsRecord.width,
              height: boundsRecord.height
            }
          : undefined,
      candidateId,
      label,
      role: "role" in raw && typeof raw.role === "string" ? raw.role : undefined,
      screenshotRef: "screenshotRef" in raw && typeof raw.screenshotRef === "string" ? raw.screenshotRef : undefined,
      snapshotAt: "snapshotAt" in raw && typeof raw.snapshotAt === "string" ? raw.snapshotAt : undefined,
      source
    } satisfies TargetDescriptor;
  }

  private focusedElementMatches(observation: DesktopObservation | undefined, label: string, preferredRole?: string) {
    const focused = observation?.focusedElement;
    if (!focused) {
      return false;
    }

    const normalizedTarget = this.normalize(label);
    const normalizedFocusedLabel = this.normalize(focused.label);
    const focusedRole = this.normalizeRoleName(focused.role);
    const normalizedRole = this.normalizeRoleName(preferredRole);

    const labelMatches =
      normalizedFocusedLabel === normalizedTarget ||
      normalizedFocusedLabel.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedFocusedLabel);
    return labelMatches && this.roleMatches(focusedRole, normalizedRole);
  }

  private hasMeaningfulObservationDiff(before: DesktopObservation | undefined, after: DesktopObservation) {
    if (!before) {
      return true;
    }

    if (before.activeApp !== after.activeApp || before.activeWindowTitle !== after.activeWindowTitle) {
      return true;
    }

    const beforeFocused = this.serializeObservationElement(before.focusedElement);
    const afterFocused = this.serializeObservationElement(after.focusedElement);
    if (beforeFocused !== afterFocused) {
      return true;
    }

    const beforeFocusedCandidates = before.candidates
      .filter((candidate) => candidate.focused)
      .map((candidate) => this.serializeObservationElement(candidate))
      .join("|");
    const afterFocusedCandidates = after.candidates
      .filter((candidate) => candidate.focused)
      .map((candidate) => this.serializeObservationElement(candidate))
      .join("|");
    if (beforeFocusedCandidates !== afterFocusedCandidates) {
      return true;
    }

    if (before.ocrText.join("|") !== after.ocrText.join("|")) {
      return true;
    }

    return before.windows.join("|") !== after.windows.join("|");
  }

  private observationIncludesText(observation: DesktopObservation | undefined, text: string) {
    if (!observation) {
      return false;
    }

    const normalizedTarget = this.normalize(text);
    if (!normalizedTarget) {
      return false;
    }

    const ocrMatch = observation.ocrText.some((entry) => this.normalize(entry).includes(normalizedTarget));
    if (ocrMatch) {
      return true;
    }

    return observation.candidates.some((candidate) => {
      const label = this.normalize(candidate.label);
      const value = this.normalize(candidate.value ?? "");
      return (
        candidate.source === "ocr" &&
        (label.includes(normalizedTarget) || value.includes(normalizedTarget))
      );
    });
  }

  private findObservationEvent(observation: DesktopObservation | undefined, kinds: string[]) {
    if (!observation) {
      return undefined;
    }

    const allowed = new Set(kinds.map((kind) => kind.toLowerCase()));
    return [...(observation.recentEvents ?? [])]
      .reverse()
      .find((event) => allowed.has(event.kind.toLowerCase()));
  }

  private serializeObservationElement(
    element:
      | DesktopObservation["focusedElement"]
      | DesktopObservation["candidates"][number]
      | undefined
  ) {
    if (!element) {
      return "";
    }

    return [
      element.id,
      this.normalizeRoleName(element.role) ?? "",
      this.normalize(element.label),
      element.value ?? "",
      element.focused ? "1" : "0"
    ].join("|");
  }

  private normalizeRoleName(role: string | undefined) {
    if (!role) {
      return undefined;
    }

    const normalized = role
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");

    if (!normalized) {
      return undefined;
    }

    if (normalized.includes("text field") || normalized.includes("textfield") || normalized.includes("input")) {
      return "text field";
    }

    if (normalized.includes("button")) {
      return "button";
    }

    if (normalized.includes("link")) {
      return "link";
    }

    return normalized;
  }

  private roleMatches(candidateRole: string | undefined, preferredRole: string | undefined) {
    if (!preferredRole) {
      return true;
    }

    if (!candidateRole) {
      return false;
    }

    return candidateRole === preferredRole || candidateRole.includes(preferredRole) || preferredRole.includes(candidateRole);
  }

  private normalize(value: string) {
    return value.trim().toLowerCase();
  }

  private isApplicationVisibleInObservation(applicationName: string, observation: DesktopObservation) {
    const expectedAliases = [
      applicationName,
      resolveApplicationAlias(applicationName)
    ]
      .map((entry) => this.normalizeApplicationTokenForVerification(entry))
      .filter(Boolean);
    if (expectedAliases.length === 0) {
      return false;
    }

    const observed = [observation.activeApp, ...observation.windows]
      .map((entry) => this.normalizeApplicationTokenForVerification(entry))
      .filter(Boolean);

    return observed.some((entry) =>
      expectedAliases.some((expected) => entry.includes(expected) || expected.includes(entry))
    );
  }

  private isLaunchAcknowledgedByBridge(
    actionKind: "ui.open_app" | "ui.activate_app",
    applicationName: string,
    executionReport: string | undefined
  ) {
    const normalizedReport = executionReport?.trim().toLowerCase();
    if (!normalizedReport) {
      return false;
    }

    const expectedPrefix = actionKind === "ui.open_app" ? "opened:" : "activated:";
    if (!normalizedReport.startsWith(expectedPrefix)) {
      return false;
    }

    const reportedApp = executionReport?.slice(expectedPrefix.length).trim();
    if (!reportedApp) {
      return true;
    }

    const expected = this.normalizeApplicationTokenForVerification(resolveApplicationAlias(applicationName));
    const reported = this.normalizeApplicationTokenForVerification(resolveApplicationAlias(reportedApp));
    return expected === reported || reported.includes(expected) || expected.includes(reported);
  }

  private isContactSelectionAcknowledgedByBridge(contact: string, executionReport: string | undefined) {
    const normalizedReport = executionReport?.trim().toLowerCase();
    if (!normalizedReport?.startsWith("selected-contact:")) {
      return false;
    }

    const reportedContact = executionReport?.slice("selected-contact:".length).trim();
    if (!reportedContact) {
      return true;
    }

    const expected = this.normalizeEntityToken(contact);
    const reported = this.normalizeEntityToken(reportedContact);
    if (!expected || !reported) {
      return false;
    }
    if (expected === reported || expected.includes(reported) || reported.includes(expected)) {
      return true;
    }

    const expectedNormalizedContact = this.normalizeEntityToken(this.normalizeContactTarget(contact));
    const reportedNormalizedContact = this.normalizeEntityToken(this.normalizeContactTarget(reportedContact));
    if (!expectedNormalizedContact || !reportedNormalizedContact) {
      return false;
    }

    return (
      expectedNormalizedContact === reportedNormalizedContact ||
      expectedNormalizedContact.includes(reportedNormalizedContact) ||
      reportedNormalizedContact.includes(expectedNormalizedContact)
    );
  }

  private isMissingAppMatchExecution(executionReport: string | undefined) {
    const normalized = executionReport?.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return normalized === "noop:no-app-match" || normalized.startsWith("failed:");
  }

  private normalizeApplicationTokenForVerification(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  }

  private normalizeEntityToken(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  }

  private replaceFirstFileHintWithPath(text: string, hint: string, path: string) {
    const resolvedPath = this.normalizePotentialFilePath(path);
    const escapedHint = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedHint, "i");
    if (regex.test(text)) {
      return text.replace(regex, `"${resolvedPath}"`);
    }
    return `${text} "${resolvedPath}"`;
  }

  private normalizePotentialFilePath(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return trimmed;
    }

    if (trimmed.startsWith("~/")) {
      return join(homedir(), trimmed.slice(2));
    }

    if (isAbsolute(trimmed)) {
      return trimmed;
    }

    if (/^(?:\.\.?\/)/.test(trimmed)) {
      return resolve(trimmed);
    }

    return trimmed;
  }

  private resolveLocalFileFromHint(rawHint: string): LocalFileResolutionResult {
    const hint = this.sanitizeFileSearchHint(rawHint);
    if (!hint || hint.length < 2) {
      return {
        status: "unresolved",
        hint,
        options: []
      };
    }

    if (/^(?:\/|~\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(hint)) {
      return {
        status: "resolved",
        path: this.normalizePotentialFilePath(hint)
      };
    }

    const searchRoots = this.resolveLocalFileSearchRoots();
    if (searchRoots.length === 0) {
      return {
        status: "unresolved",
        hint,
        options: []
      };
    }

    const maxDepth = this.parsePositiveInteger(process.env.LOBSTER_FILE_SEARCH_MAX_DEPTH, 3);
    const maxEntries = this.parsePositiveInteger(process.env.LOBSTER_FILE_SEARCH_MAX_ENTRIES, 2500);
    const maxCandidates = this.parsePositiveInteger(process.env.LOBSTER_FILE_SEARCH_MAX_CANDIDATES, 48);

    const queue: Array<{ depth: number; path: string }> = searchRoots.map((path) => ({ depth: 0, path }));
    const scored: Array<{ path: string; score: number }> = [];
    const seen = new Set<string>();
    let scannedEntries = 0;

    while (queue.length > 0 && scannedEntries < maxEntries) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      let entries;
      try {
        entries = readdirSync(current.path, {
          encoding: "utf8",
          withFileTypes: true
        });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (scannedEntries >= maxEntries) {
          break;
        }
        scannedEntries += 1;

        if (entry.name.startsWith("._")) {
          continue;
        }

        const entryPath = join(current.path, entry.name);
        const normalizedPathKey = entryPath.toLowerCase();
        if (seen.has(normalizedPathKey)) {
          continue;
        }
        seen.add(normalizedPathKey);

        if (entry.isDirectory()) {
          if (current.depth >= maxDepth) {
            continue;
          }
          if (this.shouldSkipLocalFileDirectory(entry.name)) {
            continue;
          }
          queue.push({
            depth: current.depth + 1,
            path: entryPath
          });
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const score = this.scoreLocalFileCandidate(hint, entryPath);
        if (score < 58) {
          continue;
        }

        scored.push({
          path: entryPath,
          score
        });
      }
    }

    scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const shortlisted = scored.slice(0, Math.max(1, maxCandidates));
    if (shortlisted.length === 0) {
      return {
        status: "unresolved",
        hint,
        options: []
      };
    }

    const best = shortlisted[0];
    const second = shortlisted[1];
    const bestClearWinner = !second || best.score - second.score >= 12;
    if (best.score >= 88 && bestClearWinner) {
      return {
        status: "resolved",
        path: best.path
      };
    }

    const hasStrongCandidates = best.score >= 70;
    if (hasStrongCandidates) {
      return {
        status: "ambiguous",
        hint,
        options: shortlisted.slice(0, 5).map((candidate) => candidate.path)
      };
    }

    return {
      status: "unresolved",
      hint,
      options: shortlisted.slice(0, 5).map((candidate) => candidate.path)
    };
  }

  private shouldAttemptLocalFileResolution(text: string, hint: string) {
    if (!hint.trim()) {
      return false;
    }

    if (/^(?:\/|~\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(hint.trim())) {
      return true;
    }

    return /(找一下|找找|查一下|查找|搜索|定位|where|find|search|在哪里|在哪儿|在哪裡|在哪)/i.test(text);
  }

  private resolveLocalFileSearchRoots() {
    const raw = process.env.LOBSTER_FILE_SEARCH_ROOTS?.trim();
    const configuredRoots =
      raw
        ?.split(",")
        .map((entry) => this.normalizePotentialFilePath(entry))
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    const defaultRoots = [
      join(homedir(), "Desktop"),
      join(homedir(), "Documents"),
      join(homedir(), "Downloads")
    ];
    const roots = configuredRoots.length > 0 ? configuredRoots : defaultRoots;

    return Array.from(new Set(roots.map((entry) => resolve(entry))));
  }

  private shouldSkipLocalFileDirectory(name: string) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return true;
    }
    if (normalized.startsWith(".")) {
      return true;
    }

    return [
      "node_modules",
      ".pnpm",
      ".git",
      "library",
      "applications",
      "system",
      "private",
      "volumes"
    ].includes(normalized);
  }

  private scoreLocalFileCandidate(hint: string, candidatePath: string) {
    const normalizedHint = this.normalizeEntityToken(hint);
    if (!normalizedHint) {
      return 0;
    }

    const fileName = basename(candidatePath);
    const fileStem = basename(fileName, extname(fileName));
    const normalizedName = this.normalizeEntityToken(fileName);
    const normalizedStem = this.normalizeEntityToken(fileStem);
    const normalizedPath = this.normalizeEntityToken(candidatePath);

    let score = 0;
    if (normalizedName === normalizedHint || normalizedStem === normalizedHint) {
      score = 100;
    } else if (normalizedName.includes(normalizedHint) || normalizedStem.includes(normalizedHint)) {
      score = 90;
    } else if (normalizedHint.includes(normalizedName) || normalizedHint.includes(normalizedStem)) {
      score = 74;
    } else if (normalizedPath.includes(normalizedHint)) {
      score = 68;
    } else {
      const hintTokens = this.normalizeApplicationToken(hint)
        .split(/\s+/g)
        .map((token) => this.normalizeEntityToken(token))
        .filter(Boolean);
      const overlap = hintTokens.filter(
        (token) => normalizedName.includes(token) || normalizedStem.includes(token)
      ).length;
      if (overlap > 0) {
        score = 55 + overlap * 9;
      }
    }

    const hintExtension = extname(hint).toLowerCase();
    const fileExtension = extname(fileName).toLowerCase();
    if (hintExtension && hintExtension === fileExtension) {
      score += 8;
    }

    return score;
  }

  private sanitizeFileSearchHint(rawHint: string) {
    const cleaned = rawHint
      .trim()
      .replace(/[“”"]/g, "")
      .replace(
        /\s*(?:然后|接着|随后|之后|并且|并|再|并把|并将|发送给|发给|给|上传给|上传到|to\s+|contact\s+).*/i,
        ""
      )
      .replace(/\b(?:where is|where|find|search)\b/gi, "")
      .replace(/(?:找一下|找找|查一下|查找|搜索一下|搜索|定位一下|定位)/g, "")
      .replace(/(?:在哪里|在哪儿|在哪裡|在哪里呢|在哪呢|位置)/g, "")
      .replace(/[。！!?,，:：]+$/g, "")
      .trim();
    return cleaned;
  }

  private parsePositiveInteger(raw: string | undefined, fallback: number) {
    const parsed = Number.parseInt(raw ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  private buildSemanticTargetClarificationTip(
    context: SemanticTargetContext,
    options: string[],
    fallbackHint: string
  ) {
    const preferred = options[0] ?? fallbackHint;
    if (context.kind === "contact") {
      return `请明确联系人后重试，例如：/do 在微信切换到 ${preferred} 聊天`;
    }
    if (context.kind === "file") {
      return `请明确文件名后重试，例如：/do 打开文件 "${preferred}"`;
    }
    if (context.kind === "window") {
      return `请明确窗口名后重试，例如：/do 切换到 "${preferred}" 窗口`;
    }
    return `请明确目标后重试，例如：/do 点击 "${preferred}"`;
  }

  private looksLikeSemanticFileLabel(label: string) {
    const trimmed = label.trim();
    if (!trimmed) {
      return false;
    }

    if (/[\\/]/.test(trimmed)) {
      return true;
    }

    if (/\.[A-Za-z0-9]{1,12}$/.test(trimmed)) {
      return true;
    }

    if (/(文件|文档|folder|目录|archive|draft|report|invoice|contract|memo)/i.test(trimmed)) {
      return true;
    }

    return trimmed.length >= 4 && trimmed.length <= 120;
  }

  private canonicalizeApplicationName(value: string) {
    return this.resolveKnownApplicationFromHint(value) ?? resolveApplicationAlias(value);
  }

  private shouldRetryFailedStep(action: DesktopAction, attempts: number) {
    if (action.riskLevel !== "green") {
      return false;
    }

    if (attempts >= this.maxRecoverableAttemptsPerStep) {
      return false;
    }

    return [
      "ui.open_app",
      "ui.activate_app",
      "ui.focus_target",
      "ui.click_target",
      "ui.type_into_target",
      "ui.type_text",
      "ui.paste_text"
    ].includes(action.kind);
  }

  private buildRecoverySummary(action: DesktopAction, attempts: number, previousOutcome?: string) {
    const retryIndex = attempts + 1;
    const retryBudget = this.maxRecoverableAttemptsPerStep;
    return [
      `Recovering after verification failure (${action.kind}).`,
      `Retrying attempt ${retryIndex} of ${retryBudget}.`,
      previousOutcome ? `Previous result: ${previousOutcome}` : undefined
    ]
      .filter(Boolean)
      .join(" ");
  }
}

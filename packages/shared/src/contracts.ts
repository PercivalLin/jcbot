import { z } from "zod";

export const riskLevelSchema = z.enum(["green", "yellow", "red"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "context_build",
  "planned",
  "self_checked",
  "awaiting_approval",
  "executing",
  "verifying",
  "completed",
  "blocked",
  "failed"
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSourceSchema = z.enum(["telegram", "inbox", "notification", "system", "local"]);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const executionChannelSchema = z.enum([
  "system_api",
  "apple_event",
  "ax_action",
  "cg_event",
  "visual_verify"
]);
export type ExecutionChannel = z.infer<typeof executionChannelSchema>;

export const selfCheckFindingSchema = z.object({
  ruleId: z.string(),
  riskLevel: riskLevelSchema,
  whyFlagged: z.string(),
  proposedSafeAlternative: z.string(),
  needsHumanApproval: z.boolean()
});
export type SelfCheckFinding = z.infer<typeof selfCheckFindingSchema>;

export const selfCheckResultSchema = z.object({
  overallRisk: riskLevelSchema,
  findings: z.array(selfCheckFindingSchema),
  blocked: z.boolean(),
  explanation: z.string()
});
export type SelfCheckResult = z.infer<typeof selfCheckResultSchema>;

export const uiCandidateSchema = z.object({
  id: z.string(),
  role: z.string(),
  label: z.string(),
  value: z.string().optional(),
  focused: z.boolean().optional(),
  bounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number()
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  source: z.enum(["ax", "ocr", "vision", "dom"])
});
export type UiCandidate = z.infer<typeof uiCandidateSchema>;

export const targetDescriptorSchema = z.object({
  candidateId: z.string(),
  label: z.string(),
  role: z.string().optional(),
  source: uiCandidateSchema.shape.source,
  bounds: uiCandidateSchema.shape.bounds.optional(),
  screenshotRef: z.string().optional(),
  snapshotAt: z.string().optional()
});
export type TargetDescriptor = z.infer<typeof targetDescriptorSchema>;

export const desktopObservationEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  message: z.string(),
  createdAt: z.string()
});
export type DesktopObservationEvent = z.infer<typeof desktopObservationEventSchema>;

export const desktopObservationSchema = z.object({
  screenshotRef: z.string(),
  activeApp: z.string(),
  activeWindowTitle: z.string().optional(),
  ocrText: z.array(z.string()).default([]),
  windows: z.array(z.string()).default([]),
  axTreeRef: z.string().optional(),
  snapshotAt: z.string().optional(),
  screenshotPath: z.string().optional(),
  observationMode: z.enum(["accessibility", "visual", "hybrid", "stub"]).optional(),
  focusedElement: uiCandidateSchema.optional(),
  recentEvents: z.array(desktopObservationEventSchema).optional(),
  candidates: z.array(uiCandidateSchema).default([])
});
export type DesktopObservation = z.infer<typeof desktopObservationSchema>;

export const desktopActionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  target: z.string().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
  targetDescriptor: targetDescriptorSchema.optional(),
  riskLevel: riskLevelSchema.default("green"),
  preconditions: z.array(z.string()).default([]),
  successCheck: z.array(z.string()).default([])
});
export type DesktopAction = z.infer<typeof desktopActionSchema>;

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  intent: z.string(),
  action: desktopActionSchema,
  fallback: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([])
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const taskRequestSchema = z.object({
  id: z.string(),
  source: taskSourceSchema,
  userId: z.string(),
  text: z.string(),
  attachments: z.array(z.string()).default([]),
  riskPreference: z.enum(["auto", "safe", "manual"]).default("auto"),
  createdAt: z.string()
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const approvalTokenSchema = z.object({
  id: z.string(),
  runId: z.string(),
  actionFingerprint: z.string(),
  riskLevel: riskLevelSchema,
  approvedBy: z.string(),
  expiresAt: z.string(),
  singleUse: z.boolean().default(true)
});
export type ApprovalToken = z.infer<typeof approvalTokenSchema>;

export const approvalTicketSchema = z.object({
  id: z.string(),
  runId: z.string(),
  reason: z.string(),
  action: desktopActionSchema,
  findings: z.array(selfCheckFindingSchema),
  createdAt: z.string(),
  state: z.enum(["pending", "approved", "denied", "expired"])
});
export type ApprovalTicket = z.infer<typeof approvalTicketSchema>;

export const verificationResultStatusSchema = z.enum(["verified", "dispatched_unverified", "failed"]);
export type VerificationResultStatus = z.infer<typeof verificationResultStatusSchema>;

export const verificationEvidenceItemSchema = z.object({
  source: z.enum(["local", "ocr", "vision", "bridge", "event"]),
  kind: z.string(),
  message: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  screenshotRef: z.string().optional(),
  field: z.string().optional(),
  value: z.string().optional()
});
export type VerificationEvidenceItem = z.infer<typeof verificationEvidenceItemSchema>;

export const verificationResultSchema = z.object({
  status: verificationResultStatusSchema,
  message: z.string(),
  evidence: z.array(z.string()).default([]),
  evidenceItems: z.array(verificationEvidenceItemSchema).default([])
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const taskRunSchema = z.object({
  runId: z.string(),
  request: taskRequestSchema,
  status: taskStatusSchema,
  riskLevel: riskLevelSchema,
  plan: z.array(planStepSchema),
  currentStepId: z.string().optional(),
  selfCheck: selfCheckResultSchema.optional(),
  verification: verificationResultSchema.optional(),
  latestObservation: desktopObservationSchema.optional(),
  outcomeSummary: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TaskRun = z.infer<typeof taskRunSchema>;

export const runEventKindSchema = z.enum([
  "run.created",
  "run.status_changed",
  "run.step_advanced",
  "approval.requested",
  "approval.resolved",
  "run.settled",
  "run.note"
]);
export type RunEventKind = z.infer<typeof runEventKindSchema>;

export const runEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  kind: runEventKindSchema,
  status: taskStatusSchema.optional(),
  stepId: z.string().optional(),
  message: z.string(),
  createdAt: z.string()
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const messageBindingSchema = z.object({
  id: z.string(),
  channel: z.enum(["telegram"]),
  runId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  mode: z.enum(["status_card"]),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MessageBinding = z.infer<typeof messageBindingSchema>;

export const modelProfileSchema = z.object({
  role: z.enum(["planner", "vision", "executor", "critic"]),
  provider: z.enum(["openai", "anthropic", "google", "openai-compatible"]),
  modelId: z.string(),
  baseURL: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  apiKeyRef: z.string().optional(),
  budget: z.object({
    inputTokens: z.number().int().positive(),
    outputTokens: z.number().int().positive()
  }),
  fallback: z.array(z.string()).default([])
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const inboxItemSchema = z.object({
  itemId: z.string(),
  sourceApp: z.string(),
  sourceType: taskSourceSchema,
  summary: z.string(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  riskLevel: riskLevelSchema,
  state: z.enum(["new", "triaged", "processing", "resolved", "dismissed"]),
  linkedRunId: z.string().optional(),
  createdAt: z.string()
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const skillManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  kind: z.enum(["declarative-workflow", "prompt-pack", "plugin", "composition-template"]),
  allowedActions: z.array(z.string()),
  requiredApps: z.array(z.string()).default([]),
  requiredPermissions: z.array(z.string()).default([]),
  description: z.string()
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const capabilityCandidateSchema = z.object({
  id: z.string(),
  sourceRuns: z.array(z.string()),
  artifactType: z.enum(["declarative-workflow", "prompt-pack", "plugin", "composition-template"]),
  riskClass: riskLevelSchema,
  evalScore: z.number().min(0).max(1),
  promotionState: z.enum(["draft", "staging", "stable", "held", "rejected"]),
  reason: z.string()
});
export type CapabilityCandidate = z.infer<typeof capabilityCandidateSchema>;

export const policyDecisionSchema = z.object({
  allowed: z.boolean(),
  riskLevel: riskLevelSchema,
  requiresApproval: z.boolean(),
  reason: z.string(),
  ruleIds: z.array(z.string()).default([])
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

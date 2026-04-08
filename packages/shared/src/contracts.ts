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

export const taskSourceSchema = z.enum(["telegram", "inbox", "notification", "system"]);
export type TaskSource = z.infer<typeof taskSourceSchema>;

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

export const desktopObservationSchema = z.object({
  screenshotRef: z.string(),
  activeApp: z.string(),
  activeWindowTitle: z.string().optional(),
  ocrText: z.array(z.string()).default([]),
  windows: z.array(z.string()).default([]),
  axTreeRef: z.string().optional(),
  candidates: z.array(uiCandidateSchema).default([])
});
export type DesktopObservation = z.infer<typeof desktopObservationSchema>;

export const desktopActionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  target: z.string().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
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

export const taskRunSchema = z.object({
  runId: z.string(),
  request: taskRequestSchema,
  status: taskStatusSchema,
  riskLevel: riskLevelSchema,
  plan: z.array(planStepSchema),
  currentStepId: z.string().optional(),
  selfCheck: selfCheckResultSchema.optional(),
  outcomeSummary: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TaskRun = z.infer<typeof taskRunSchema>;

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

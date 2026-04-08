import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const taskRuns = sqliteTable("task_runs", {
  runId: text("run_id").primaryKey(),
  runJson: text("run_json").notNull(),
  status: text("status").notNull(),
  riskLevel: text("risk_level").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const approvalTickets = sqliteTable("approval_tickets", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  ticketJson: text("ticket_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const inboxItems = sqliteTable("inbox_items", {
  itemId: text("item_id").primaryKey(),
  itemJson: text("item_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const capabilityCandidates = sqliteTable("capability_candidates", {
  id: text("id").primaryKey(),
  candidateJson: text("candidate_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const runtimeState = sqliteTable("runtime_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const runEvents = sqliteTable("run_events", {
  eventId: text("event_id").primaryKey(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  eventJson: text("event_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const messageBindings = sqliteTable("message_bindings", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  runId: text("run_id").notNull(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  mode: text("mode").notNull(),
  bindingJson: text("binding_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

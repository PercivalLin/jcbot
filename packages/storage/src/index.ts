import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ApprovalTicket, CapabilityCandidate, InboxItem, TaskRun } from "@lobster/shared";
import {
  approvalTicketSchema,
  capabilityCandidateSchema,
  inboxItemSchema,
  taskRunSchema
} from "@lobster/shared";
import * as schema from "./schema.js";

type PersistenceSnapshot = {
  approvals: ApprovalTicket[];
  capabilityCandidates: CapabilityCandidate[];
  inboxItems: InboxItem[];
  runs: TaskRun[];
  runtimeState: Record<string, string>;
};

export type RuntimePersistence = {
  backend: "sqlite" | "json-file";
  getApproval(ticketId: string): Promise<ApprovalTicket | undefined>;
  getRun(runId: string): Promise<TaskRun | undefined>;
  getRuntimeValue(key: string): Promise<string | undefined>;
  listApprovals(): Promise<ApprovalTicket[]>;
  listCapabilityCandidates(): Promise<CapabilityCandidate[]>;
  listInboxItems(): Promise<InboxItem[]>;
  listRuns(): Promise<TaskRun[]>;
  saveApproval(ticket: ApprovalTicket): Promise<void>;
  saveCapabilityCandidate(candidate: CapabilityCandidate): Promise<void>;
  saveInboxItem(item: InboxItem): Promise<void>;
  saveRun(run: TaskRun): Promise<void>;
  setRuntimeValue(key: string, value: string): Promise<void>;
};

type CreateRuntimePersistenceOptions = {
  path: string;
};

const EMPTY_SNAPSHOT: PersistenceSnapshot = {
  approvals: [],
  capabilityCandidates: [],
  inboxItems: [],
  runs: [],
  runtimeState: {}
};

function sortByNewest<T extends { createdAt: string }>(items: T[]) {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

class JsonFileRuntimePersistence implements RuntimePersistence {
  readonly backend = "json-file" as const;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      this.persist(EMPTY_SNAPSHOT);
    }
  }

  async getApproval(ticketId: string) {
    return this.read().approvals.find((ticket) => ticket.id === ticketId);
  }

  async getRun(runId: string) {
    return this.read().runs.find((run) => run.runId === runId);
  }

  async getRuntimeValue(key: string) {
    return this.read().runtimeState[key];
  }

  async listApprovals() {
    return sortByNewest(this.read().approvals);
  }

  async listCapabilityCandidates() {
    return [...this.read().capabilityCandidates];
  }

  async listInboxItems() {
    return sortByNewest(this.read().inboxItems);
  }

  async listRuns() {
    return sortByNewest(this.read().runs);
  }

  async saveApproval(ticket: ApprovalTicket) {
    const snapshot = this.read();
    snapshot.approvals = upsert(snapshot.approvals, ticket, "id");
    this.persist(snapshot);
  }

  async saveCapabilityCandidate(candidate: CapabilityCandidate) {
    const snapshot = this.read();
    snapshot.capabilityCandidates = upsert(snapshot.capabilityCandidates, candidate, "id");
    this.persist(snapshot);
  }

  async saveInboxItem(item: InboxItem) {
    const snapshot = this.read();
    snapshot.inboxItems = upsert(snapshot.inboxItems, item, "itemId");
    this.persist(snapshot);
  }

  async saveRun(run: TaskRun) {
    const snapshot = this.read();
    snapshot.runs = upsert(snapshot.runs, run, "runId");
    this.persist(snapshot);
  }

  async setRuntimeValue(key: string, value: string) {
    const snapshot = this.read();
    snapshot.runtimeState = {
      ...snapshot.runtimeState,
      [key]: value
    };
    this.persist(snapshot);
  }

  private read(): PersistenceSnapshot {
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistenceSnapshot>;

    return {
      approvals: (parsed.approvals ?? []).map((item) => approvalTicketSchema.parse(item)),
      capabilityCandidates: (parsed.capabilityCandidates ?? []).map((item) =>
        capabilityCandidateSchema.parse(item)
      ),
      inboxItems: (parsed.inboxItems ?? []).map((item) => inboxItemSchema.parse(item)),
      runs: (parsed.runs ?? []).map((item) => taskRunSchema.parse(item)),
      runtimeState:
        parsed.runtimeState && typeof parsed.runtimeState === "object" ? sanitizeRuntimeState(parsed.runtimeState) : {}
    };
  }

  private persist(snapshot: PersistenceSnapshot) {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
    renameSync(tempPath, this.filePath);
  }
}

class SqliteRuntimePersistence implements RuntimePersistence {
  readonly backend = "sqlite" as const;
  private readonly db: any;

  constructor(private readonly sqlite: any, private readonly dbPath: string) {
    this.db = drizzle(this.sqlite, { schema });
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        run_json TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approval_tickets (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        ticket_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox_items (
        item_id TEXT PRIMARY KEY,
        item_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_candidates (
        id TEXT PRIMARY KEY,
        candidate_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async getApproval(ticketId: string) {
    const [row] = await this.db
      .select()
      .from(schema.approvalTickets)
      .where(eq(schema.approvalTickets.id, ticketId))
      .limit(1);
    return row ? approvalTicketSchema.parse(JSON.parse(row.ticketJson)) : undefined;
  }

  async getRun(runId: string) {
    const [row] = await this.db.select().from(schema.taskRuns).where(eq(schema.taskRuns.runId, runId)).limit(1);
    return row ? taskRunSchema.parse(JSON.parse(row.runJson)) : undefined;
  }

  async getRuntimeValue(key: string) {
    const [row] = await this.db
      .select()
      .from(schema.runtimeState)
      .where(eq(schema.runtimeState.key, key))
      .limit(1);
    return row?.value;
  }

  async listApprovals() {
    const rows = await this.db.select().from(schema.approvalTickets).orderBy(desc(schema.approvalTickets.createdAt));
    return rows.map((row: any) => approvalTicketSchema.parse(JSON.parse(row.ticketJson)));
  }

  async listCapabilityCandidates() {
    const rows = await this.db
      .select()
      .from(schema.capabilityCandidates)
      .orderBy(desc(schema.capabilityCandidates.createdAt));
    return rows.map((row: any) => capabilityCandidateSchema.parse(JSON.parse(row.candidateJson)));
  }

  async listInboxItems() {
    const rows = await this.db.select().from(schema.inboxItems).orderBy(desc(schema.inboxItems.createdAt));
    return rows.map((row: any) => inboxItemSchema.parse(JSON.parse(row.itemJson)));
  }

  async listRuns() {
    const rows = await this.db.select().from(schema.taskRuns).orderBy(desc(schema.taskRuns.createdAt));
    return rows.map((row: any) => taskRunSchema.parse(JSON.parse(row.runJson)));
  }

  async saveApproval(ticket: ApprovalTicket) {
    await this.db
      .insert(schema.approvalTickets)
      .values({
        id: ticket.id,
        runId: ticket.runId,
        ticketJson: JSON.stringify(ticket),
        createdAt: new Date(ticket.createdAt)
      })
      .onConflictDoUpdate({
        target: schema.approvalTickets.id,
        set: {
          runId: ticket.runId,
          ticketJson: JSON.stringify(ticket),
          createdAt: new Date(ticket.createdAt)
        }
      });
  }

  async saveCapabilityCandidate(candidate: CapabilityCandidate) {
    await this.db
      .insert(schema.capabilityCandidates)
      .values({
        id: candidate.id,
        candidateJson: JSON.stringify(candidate),
        createdAt: new Date()
      })
      .onConflictDoUpdate({
        target: schema.capabilityCandidates.id,
        set: {
          candidateJson: JSON.stringify(candidate),
          createdAt: new Date()
        }
      });
  }

  async saveInboxItem(item: InboxItem) {
    await this.db
      .insert(schema.inboxItems)
      .values({
        itemId: item.itemId,
        itemJson: JSON.stringify(item),
        createdAt: new Date(item.createdAt)
      })
      .onConflictDoUpdate({
        target: schema.inboxItems.itemId,
        set: {
          itemJson: JSON.stringify(item),
          createdAt: new Date(item.createdAt)
        }
      });
  }

  async saveRun(run: TaskRun) {
    await this.db
      .insert(schema.taskRuns)
      .values({
        runId: run.runId,
        runJson: JSON.stringify(run),
        status: run.status,
        riskLevel: run.riskLevel,
        createdAt: new Date(run.createdAt),
        updatedAt: new Date(run.updatedAt)
      })
      .onConflictDoUpdate({
        target: schema.taskRuns.runId,
        set: {
          runJson: JSON.stringify(run),
          status: run.status,
          riskLevel: run.riskLevel,
          createdAt: new Date(run.createdAt),
          updatedAt: new Date(run.updatedAt)
        }
      });
  }

  async setRuntimeValue(key: string, value: string) {
    await this.db
      .insert(schema.runtimeState)
      .values({
        key,
        value,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: schema.runtimeState.key,
        set: {
          value,
          updatedAt: new Date()
        }
      });
  }
}

export async function createRuntimePersistence(
  options: CreateRuntimePersistenceOptions
): Promise<RuntimePersistence> {
  mkdirSync(dirname(options.path), { recursive: true });

  try {
    const sqliteModule = await loadOptionalBetterSqlite3();
    const Database = (sqliteModule as { default?: new (path: string) => any }).default ?? (sqliteModule as unknown as new (path: string) => any);
    const sqlite = new Database(options.path);
    return new SqliteRuntimePersistence(sqlite, options.path);
  } catch (error) {
    const fallbackPath = options.path.replace(/\.(sqlite|db)$/u, "") + ".json";
    console.warn(
      `Falling back to JSON persistence at ${fallbackPath} because SQLite could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new JsonFileRuntimePersistence(fallbackPath);
  }
}

async function loadOptionalBetterSqlite3(): Promise<any> {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3");
}

function upsert<T, K extends keyof T>(items: T[], next: T, key: K): T[] {
  const index = items.findIndex((item) => item[key] === next[key]);
  if (index === -1) {
    return [next, ...items];
  }

  const cloned = [...items];
  cloned[index] = next;
  return cloned;
}

function sanitizeRuntimeState(input: object): Record<string, string> {
  const entries = Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

export * from "./schema.js";

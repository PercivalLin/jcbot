import net from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApprovalTicket, JsonRpcResponse, TaskRequest, TaskRun } from "@lobster/shared";
import { loadRuntimeEnvFile } from "../modules/runtimeEnv.js";

loadRuntimeEnvFile();

const SOCKET_PATH = process.env.LOBSTER_SOCKET_PATH ?? "/tmp/lobster/lobsterd.sock";
const LOCAL_USER_ID = process.env.LOBSTER_LOCAL_CHAT_USER_ID?.trim() || "local-cli-user";

type CreatedTaskResult = {
  run: TaskRun;
  approvalTicket?: ApprovalTicket;
};

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("Lobster Local Chat");
  console.log(`Socket: ${SOCKET_PATH}`);
  console.log("Commands: /help /runs /approvals /approve <ticketId> /deny <ticketId> /exit");
  console.log("Type anything else to create a task.");
  console.log("");

  try {
    while (true) {
      const line = (await rl.question("you> ")).trim();
      if (!line) {
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        break;
      }

      if (line === "/help") {
        printHelp();
        continue;
      }

      if (line === "/runs") {
        await showRuns();
        continue;
      }

      if (line === "/approvals") {
        await showApprovals();
        continue;
      }

      if (line.startsWith("/approve ")) {
        const ticketId = line.slice("/approve ".length).trim();
        if (!ticketId) {
          console.log("lobster> missing ticket id.");
          continue;
        }
        await approveTicket(ticketId);
        continue;
      }

      if (line.startsWith("/deny ")) {
        const ticketId = line.slice("/deny ".length).trim();
        if (!ticketId) {
          console.log("lobster> missing ticket id.");
          continue;
        }
        await denyTicket(ticketId);
        continue;
      }

      await createTask(line);
    }
  } finally {
    rl.close();
  }
}

async function createTask(text: string) {
  const request: TaskRequest = {
    id: randomUUID(),
    source: "system",
    userId: LOCAL_USER_ID,
    text,
    attachments: [],
    riskPreference: "auto",
    createdAt: new Date().toISOString()
  };

  try {
    const result = await callDaemon("task.create", request) as CreatedTaskResult;
    console.log(`lobster> run ${result.run.runId} created, status=${result.run.status}`);
    if (result.approvalTicket) {
      console.log(`lobster> approval required: ${result.approvalTicket.id} (${result.approvalTicket.reason})`);
    } else if (result.run.outcomeSummary) {
      console.log(`lobster> ${result.run.outcomeSummary}`);
    }
  } catch (error) {
    console.log(`lobster> failed to create task: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function showRuns() {
  try {
    const runs = await callDaemon("run.list") as TaskRun[];
    if (runs.length === 0) {
      console.log("lobster> no runs yet.");
      return;
    }

    for (const run of runs.slice(0, 8)) {
      console.log(`- ${run.runId} | ${run.status} | ${run.request.text}`);
    }
  } catch (error) {
    console.log(`lobster> failed to list runs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function showApprovals() {
  try {
    const approvals = await callDaemon("approval.list") as ApprovalTicket[];
    const pending = approvals.filter((ticket) => ticket.state === "pending");
    if (pending.length === 0) {
      console.log("lobster> no pending approvals.");
      return;
    }

    for (const ticket of pending.slice(0, 8)) {
      console.log(`- ${ticket.id} | run=${ticket.runId} | ${ticket.reason}`);
    }
  } catch (error) {
    console.log(`lobster> failed to list approvals: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function approveTicket(ticketId: string) {
  try {
    const result = await callDaemon("approval.approve", {
      ticketId,
      approvedBy: LOCAL_USER_ID
    }) as { run: TaskRun };
    console.log(`lobster> approved ${ticketId}. run status=${result.run.status}`);
  } catch (error) {
    console.log(`lobster> failed to approve: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function denyTicket(ticketId: string) {
  try {
    const run = await callDaemon("approval.deny", { ticketId }) as TaskRun | undefined;
    if (!run) {
      console.log(`lobster> denied ${ticketId}.`);
      return;
    }
    console.log(`lobster> denied ${ticketId}. run status=${run.status}`);
  } catch (error) {
    console.log(`lobster> failed to deny: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function callDaemon(method: string, params?: unknown) {
  return new Promise<JsonRpcResponse["result"]>((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params
    });

    let buffer = "";
    client.once("error", (error) => {
      reject(
        new Error(
          `cannot connect to lobsterd at ${SOCKET_PATH}: ${error.message}. Start daemon with: pnpm dev:daemon`
        )
      );
    });
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      if (lines.length < 2) {
        return;
      }

      const raw = lines.shift()?.trim();
      buffer = lines.join("\n");
      if (!raw) {
        return;
      }

      try {
        const response = JSON.parse(raw) as JsonRpcResponse;
        client.end();
        if (response.error) {
          reject(new Error(response.error.message));
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    client.write(`${request}\n`);
  });
}

function printHelp() {
  console.log("lobster> /runs: list recent runs");
  console.log("lobster> /approvals: list pending approvals");
  console.log("lobster> /approve <ticketId>: approve a pending yellow action");
  console.log("lobster> /deny <ticketId>: deny a pending yellow action");
  console.log("lobster> /exit: quit local chat");
}

void main();

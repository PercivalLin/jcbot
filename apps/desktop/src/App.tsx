import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lobsterApi } from "./lib/api";
import { Panel } from "./components/Panel";
import { RunList } from "./components/RunList";
import { ApprovalList } from "./components/ApprovalList";
import { InboxList } from "./components/InboxList";
import { ModelTable } from "./components/ModelTable";
import { BridgeCapabilities } from "./components/BridgeCapabilities";
import { RuntimeReadiness } from "./components/RuntimeReadiness";

export default function App() {
  const queryClient = useQueryClient();
  const [chatInput, setChatInput] = useState("");

  const runs = useQuery({ queryKey: ["runs"], queryFn: lobsterApi.listRuns });
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: lobsterApi.listApprovals });
  const bridge = useQuery({ queryKey: ["bridge"], queryFn: lobsterApi.bridgeCapabilities });
  const readiness = useQuery({ queryKey: ["runtime-readiness"], queryFn: lobsterApi.runtimeReadiness });
  const models = useQuery({ queryKey: ["models"], queryFn: lobsterApi.listModels });
  const skills = useQuery({ queryKey: ["skills"], queryFn: lobsterApi.listSkills });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: lobsterApi.listInbox });

  const approve = useMutation({
    mutationFn: (ticketId: string) => lobsterApi.approveTicket(ticketId, "desktop-user"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    }
  });

  const deny = useMutation({
    mutationFn: (ticketId: string) => lobsterApi.denyTicket(ticketId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    }
  });

  const createTask = useMutation({
    mutationFn: (text: string) =>
      lobsterApi.createTask({
        id: crypto.randomUUID(),
        source: "system",
        userId: "desktop-user",
        text: text.trim(),
        attachments: [],
        riskPreference: "auto",
        createdAt: new Date().toISOString()
      }),
    onSuccess: async () => {
      setChatInput("");
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    }
  });

  const skillSummary = useMemo(() => {
    if (!skills.data) {
      return "loading...";
    }
    return `starter ${skills.data.starter.length} | staging ${skills.data.staging.length} | stable ${skills.data.stable.length} | held ${skills.data.held.length}`;
  }, [skills.data]);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: 32,
        color: "#25190f",
        background:
          "radial-gradient(circle at top left, rgba(255,238,197,0.85), transparent 34%), linear-gradient(135deg, #f4efe7 0%, #efe0cf 100%)",
        fontFamily: "\"Iowan Old Style\", \"Palatino Linotype\", serif"
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.2em", color: "#84684b" }}>
          Lobster v1 Console
        </div>
        <h1 style={{ margin: "8px 0 6px", fontSize: 42 }}>Constraint-first computer-use</h1>
        <p style={{ margin: 0, maxWidth: 760, color: "#5f513d" }}>
          Local operator view for runs, constitution-driven approvals, inbox signals, and staged skill evolution.
        </p>
      </header>

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "1.2fr 1fr" }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <Panel title="Runtime Readiness">
            <RuntimeReadiness report={readiness.data} />
          </Panel>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Panel title="Chat Robot">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = chatInput.trim();
                if (!trimmed || createTask.isPending) {
                  return;
                }
                void createTask.mutateAsync(trimmed);
              }}
            >
              <textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="例如：打开微信，找到张三，输入“晚上八点前给我回执（先不要发送）”。"
                rows={3}
                style={{
                  width: "100%",
                  borderRadius: 10,
                  border: "1px solid #d9cbb8",
                  padding: 12,
                  fontSize: 15,
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box",
                  background: "#fffdf8"
                }}
              />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                <span style={{ color: "#6b5d46", fontSize: 12 }}>
                  Enter to send from desktop; approvals still appear below when required.
                </span>
                <button
                  type="submit"
                  disabled={createTask.isPending || chatInput.trim().length === 0}
                  style={{
                    borderRadius: 999,
                    border: "1px solid #4f3923",
                    background: "#5b4028",
                    color: "#fff8ef",
                    padding: "8px 16px",
                    cursor: createTask.isPending ? "not-allowed" : "pointer",
                    opacity: createTask.isPending ? 0.65 : 1
                  }}
                >
                  {createTask.isPending ? "Sending..." : "Send Task"}
                </button>
              </div>
            </form>
          </Panel>
        </div>
        <Panel title="Runs">
          <RunList runs={runs.data ?? []} />
        </Panel>
        <Panel title="Approvals">
          <ApprovalList
            approvals={approvals.data ?? []}
            onApprove={(ticketId) => approve.mutateAsync(ticketId).then(() => undefined)}
            onDeny={(ticketId) => deny.mutateAsync(ticketId).then(() => undefined)}
          />
        </Panel>
        <Panel title="Inbox">
          <InboxList items={inbox.data ?? []} />
        </Panel>
        <Panel title={`Skills (${skillSummary})`}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(skills.data, null, 2)}</pre>
        </Panel>
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ display: "grid", gap: 20, gridTemplateColumns: "1.4fr 1fr" }}>
            <Panel title="Model Profiles">
              <ModelTable models={models.data ?? null} />
            </Panel>
            <Panel title="Bridge">
              <BridgeCapabilities capabilities={bridge.data ?? null} />
            </Panel>
          </div>
        </div>
      </div>
    </main>
  );
}

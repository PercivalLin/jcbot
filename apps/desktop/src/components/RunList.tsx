import type { TaskRun } from "@lobster/shared";

export function RunList({ runs }: { runs: TaskRun[] }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {runs.map((run) => (
        <article
          key={run.runId}
          style={{
            padding: 14,
            borderRadius: 16,
            background: "#fff8ef",
            border: "1px solid #eadfcd"
          }}
        >
          <strong>{run.request.text}</strong>
          <div style={{ fontSize: 13, marginTop: 8, color: "#6b5d46" }}>
            status: {run.status} | risk: {run.riskLevel} | steps: {run.plan.length}
          </div>
          {run.outcomeSummary ? (
            <div style={{ fontSize: 13, marginTop: 8, color: "#4f4535" }}>{run.outcomeSummary}</div>
          ) : null}
        </article>
      ))}
      {runs.length === 0 ? <span style={{ color: "#6b5d46" }}>No runs yet.</span> : null}
    </div>
  );
}

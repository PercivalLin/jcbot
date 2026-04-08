import type { AdminRun } from "../lib/adminApi";
import { navigate } from "../lib/router";
import { formatDateTime } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

function statusTone(status: string | undefined): "neutral" | "ok" | "warn" | "fail" | "accent" {
  switch (status) {
    case "completed":
      return "ok";
    case "awaiting_approval":
    case "blocked":
      return "warn";
    case "failed":
      return "fail";
    case "running":
      return "accent";
    default:
      return "neutral";
  }
}

export function RunTable({ runs }: { runs: AdminRun[] }) {
  if (runs.length === 0) {
    return <div className="empty-state">No runs yet. Trigger one from Telegram or the desktop console.</div>;
  }

  return (
    <div className="run-table">
      {runs.map((run) => (
        <button key={run.id} type="button" className="run-row" onClick={() => navigate(`/runs/${run.id}`)}>
          <div className="run-row__main">
            <div className="run-row__title">{run.text || run.summary || "Untitled run"}</div>
            <div className="run-row__meta">
              <span>{run.id.slice(0, 8)}</span>
              <span>{run.source || "unknown source"}</span>
              <span>{formatDateTime(run.updatedAt || run.createdAt)}</span>
            </div>
          </div>
          <StatusBadge tone={statusTone(run.status)} label={run.status || "unknown"} />
        </button>
      ))}
    </div>
  );
}

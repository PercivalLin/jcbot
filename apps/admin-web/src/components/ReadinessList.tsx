import type { AdminReadinessReport } from "../lib/adminApi";
import { StatusBadge } from "./StatusBadge";

function toneForLevel(level: "ok" | "warn" | "fail") {
  switch (level) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    default:
      return "fail";
  }
}

export function ReadinessList({ report }: { report: AdminReadinessReport | undefined }) {
  if (!report) {
    return <div className="empty-state">No readiness payload returned by the backend yet.</div>;
  }

  return (
    <div className="stack">
      {report.checks.map((check) => (
        <div key={check.id} className="readiness-item">
          <div className="readiness-item__heading">
            <strong>{check.id}</strong>
            <StatusBadge tone={toneForLevel(check.level)} label={check.level} />
          </div>
          <p>{check.message}</p>
          {check.suggestion ? <small>{check.suggestion}</small> : null}
        </div>
      ))}
    </div>
  );
}

type RuntimeReadinessProps = {
  report:
    | {
        checks: Array<{
          id: string;
          level: "ok" | "warn" | "fail";
          message: string;
          suggestion?: string;
        }>;
        generatedAt: string;
        summary: {
          fail: number;
          ok: number;
          warn: number;
        };
      }
    | null
    | undefined;
};

export function RuntimeReadiness({ report }: RuntimeReadinessProps) {
  if (!report) {
    return <span style={{ color: "#6b5d46" }}>Runtime readiness unavailable.</span>;
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 13, color: "#6b5d46" }}>
        Updated: {new Date(report.generatedAt).toLocaleString()} | ok={report.summary.ok} warn={report.summary.warn} fail={report.summary.fail}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {report.checks.map((check) => (
          <div
            key={check.id}
            style={{
              borderRadius: 10,
              padding: "10px 12px",
              border: `1px solid ${borderColor(check.level)}`,
              background: backgroundColor(check.level)
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              [{check.level.toUpperCase()}] {check.id}
            </div>
            <div style={{ fontSize: 13, marginTop: 3 }}>{check.message}</div>
            {check.suggestion ? <div style={{ fontSize: 12, marginTop: 5, color: "#5f513d" }}>{check.suggestion}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function borderColor(level: "ok" | "warn" | "fail") {
  switch (level) {
    case "ok":
      return "#6f8e57";
    case "warn":
      return "#b4883a";
    case "fail":
      return "#b45743";
  }
}

function backgroundColor(level: "ok" | "warn" | "fail") {
  switch (level) {
    case "ok":
      return "rgba(111, 142, 87, 0.12)";
    case "warn":
      return "rgba(180, 136, 58, 0.14)";
    case "fail":
      return "rgba(180, 87, 67, 0.14)";
  }
}

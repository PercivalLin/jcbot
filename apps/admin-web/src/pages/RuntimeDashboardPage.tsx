import { useQuery } from "@tanstack/react-query";
import { Card } from "../components/Card";
import { KeyValueList } from "../components/KeyValueList";
import { ReadinessList } from "../components/ReadinessList";
import { RunTable } from "../components/RunTable";
import { StatusBadge } from "../components/StatusBadge";
import type { AdminObservationElement, AdminObservationEvent, AdminRun } from "../lib/adminApi";
import { adminApi } from "../lib/adminApi";
import { formatDateTime, toDisplayValue } from "../lib/format";

const screenshotStyle = {
  border: "1px solid rgba(15, 23, 42, 0.12)",
  borderRadius: "12px",
  display: "block",
  maxWidth: "100%"
} as const;

export function RuntimeDashboardPage() {
  const readiness = useQuery({ queryKey: ["admin", "readiness"], queryFn: adminApi.getReadiness });
  const runtime = useQuery({ queryKey: ["admin", "runtime"], queryFn: adminApi.getRuntime, refetchInterval: 15000 });
  const runs = useQuery({ queryKey: ["admin", "runs"], queryFn: adminApi.listRuns, refetchInterval: 15000 });
  const currentRun = runtime.data?.currentRun;
  const observation = currentRun?.latestObservation;

  return (
    <div className="page-grid">
      <Card title="Readiness" subtitle="Permission, model, and runtime checks from the daemon.">
        <ReadinessList report={readiness.data} />
      </Card>

      <Card title="Bridge status" subtitle="Thin summary of the native bridge health contract.">
        <KeyValueList
          entries={[
            { key: "Status", value: toDisplayValue(runtime.data?.bridge?.status) },
            { key: "Healthy", value: toDisplayValue(runtime.data?.bridge?.healthy) },
            { key: "Protocol", value: toDisplayValue(runtime.data?.bridge?.protocolVersion) },
            { key: "Permissions", value: toDisplayValue(runtime.data?.bridge?.permissions) }
          ]}
        />
      </Card>

      <Card title="Current desktop run" subtitle="The run currently occupying the desktop lease, if any.">
        {currentRun ? (
          <div className="stack">
            <div className="inline-row">
              <strong>{currentRun.text || currentRun.summary || currentRun.id}</strong>
              <StatusBadge tone="accent" label={currentRun.status || "running"} />
            </div>
            <KeyValueList
              entries={[
                { key: "Run ID", value: currentRun.id },
                { key: "Source", value: toDisplayValue(currentRun.source) },
                { key: "Updated", value: formatDateTime(currentRun.updatedAt) },
                { key: "Result", value: toDisplayValue(currentRun.result) },
                { key: "Verification", value: toDisplayValue(currentRun.verification?.status) },
                { key: "Observation mode", value: toDisplayValue(observation?.observationMode) },
                { key: "Active app", value: toDisplayValue(observation?.activeApp) },
                { key: "Active window", value: toDisplayValue(observation?.activeWindowTitle) }
              ]}
            />

            {currentRun.verification ? (
              <div className="stack">
                <strong>Verification summary</strong>
                <div>{toDisplayValue(currentRun.verification.message)}</div>
                {currentRun.verification.evidenceItems?.length ? (
                  <pre className="code-block">{currentRun.verification.evidenceItems.slice(0, 3).map(formatEvidenceItem).join("\n")}</pre>
                ) : null}
                {currentRun.verification.evidence?.length ? (
                  <pre className="code-block">{currentRun.verification.evidence.slice(0, 3).join("\n")}</pre>
                ) : null}
              </div>
            ) : null}

            {observation ? (
              <div className="stack">
                {observation.screenshotUrl ? (
                  <div className="stack">
                    <strong>Latest screenshot</strong>
                    <a href={observation.screenshotUrl} target="_blank" rel="noreferrer">
                      <img
                        alt={`Run ${currentRun.id} current evidence screenshot`}
                        src={observation.screenshotUrl}
                        style={screenshotStyle}
                      />
                    </a>
                  </div>
                ) : null}

                <div className="stack">
                  <strong>OCR preview</strong>
                  {observation.ocrText && observation.ocrText.length > 0 ? (
                    <pre className="code-block">{observation.ocrText.slice(0, 3).join("\n")}</pre>
                  ) : (
                    <div className="empty-state">No OCR tokens retained for the current run.</div>
                  )}
                </div>

                <div className="stack">
                  <strong>Focused element</strong>
                  {observation.focusedElement ? (
                    <pre className="code-block">{formatObservationElement(observation.focusedElement)}</pre>
                  ) : (
                    <div className="empty-state">No focused element retained for the current run.</div>
                  )}
                </div>

                <div className="stack">
                  <strong>Recent events</strong>
                  {observation.recentEvents && observation.recentEvents.length > 0 ? (
                    <pre className="code-block">{observation.recentEvents.slice(-2).map(formatObservationEvent).join("\n")}</pre>
                  ) : (
                    <div className="empty-state">No recent observation events retained.</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">No active desktop run reported right now.</div>
        )}
      </Card>

      <Card title="Runtime facts" subtitle="Loose backend payload, rendered defensively for the first iteration.">
        <pre className="code-block">{JSON.stringify(runtime.data?.runtime ?? {}, null, 2)}</pre>
      </Card>

      <Card title="Recent runs" subtitle="Click through to inspect the event timeline.">
        <RunTable runs={runs.data ?? []} />
      </Card>
    </div>
  );
}

function formatObservationElement(element: AdminObservationElement) {
  const segments = [
    element.label || "(no label)",
    `role=${element.role}`,
    element.source ? `source=${element.source}` : undefined,
    element.focused ? "focused=true" : undefined,
    typeof element.confidence === "number" ? `confidence=${element.confidence.toFixed(2)}` : undefined,
    element.value ? `value=${element.value}` : undefined
  ].filter(Boolean);
  return segments.join(" | ");
}

function formatObservationEvent(event: AdminObservationEvent) {
  return `${formatDateTime(event.createdAt)}  ${event.kind}  ${event.message}`;
}

function formatEvidenceItem(item: NonNullable<NonNullable<AdminRun["verification"]>["evidenceItems"]>[number]) {
  const segments = [
    item.source ? `source=${item.source}` : undefined,
    item.kind ? `kind=${item.kind}` : undefined,
    item.field ? `field=${item.field}` : undefined,
    typeof item.confidence === "number" ? `confidence=${item.confidence.toFixed(2)}` : undefined,
    item.screenshotRef ? `shot=${item.screenshotRef}` : undefined,
    item.value ? `value=${item.value}` : undefined,
    item.message
  ].filter(Boolean);
  return segments.join(" | ");
}

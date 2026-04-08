import { useQuery } from "@tanstack/react-query";
import { Card } from "../components/Card";
import { KeyValueList } from "../components/KeyValueList";
import { Timeline } from "../components/Timeline";
import type { AdminObservationElement, AdminObservationEvent, AdminRun } from "../lib/adminApi";
import { adminApi } from "../lib/adminApi";
import { formatDateTime, toDisplayValue } from "../lib/format";

const screenshotStyle = {
  border: "1px solid rgba(15, 23, 42, 0.12)",
  borderRadius: "12px",
  display: "block",
  maxWidth: "100%"
} as const;

export function RunDetailPage({ runId }: { runId: string }) {
  const run = useQuery({ queryKey: ["admin", "run", runId], queryFn: () => adminApi.getRun(runId) });
  const events = useQuery({
    queryKey: ["admin", "run-events", runId],
    queryFn: () => adminApi.getRunEvents(runId),
    refetchInterval: 15000
  });

  const observation = run.data?.latestObservation;

  return (
    <div className="page-grid">
      <Card title="Run summary" subtitle="Top-level payload returned by GET /api/admin/runs/:id.">
        {run.data ? (
          <div className="stack">
            <KeyValueList
              entries={[
                { key: "Run ID", value: run.data.id },
                { key: "Status", value: toDisplayValue(run.data.status) },
                { key: "Source", value: toDisplayValue(run.data.source) },
                { key: "Created", value: formatDateTime(run.data.createdAt) },
                { key: "Updated", value: formatDateTime(run.data.updatedAt) },
                { key: "Prompt", value: toDisplayValue(run.data.text) },
                { key: "Result", value: toDisplayValue(run.data.result ?? run.data.summary) },
                { key: "Verification", value: toDisplayValue(run.data.verification?.status) }
              ]}
            />
            {run.data.verification ? (
              <div className="stack">
                <strong>Verification Detail</strong>
                <div>{toDisplayValue(run.data.verification.message)}</div>
                {run.data.verification.evidenceItems && run.data.verification.evidenceItems.length > 0 ? (
                  <pre className="code-block">{run.data.verification.evidenceItems.map(formatEvidenceItem).join("\n")}</pre>
                ) : null}
                {run.data.verification.evidence && run.data.verification.evidence.length > 0 ? (
                  <pre className="code-block">{run.data.verification.evidence.join("\n")}</pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">Loading run details...</div>
        )}
      </Card>

      <Card title="Observation evidence" subtitle="Latest AX/OCR/visual snapshot retained for this run.">
        {observation ? (
          <div className="stack">
            <KeyValueList
              entries={[
                { key: "Snapshot", value: formatDateTime(observation.snapshotAt) },
                { key: "Mode", value: toDisplayValue(observation.observationMode) },
                { key: "Active app", value: toDisplayValue(observation.activeApp) },
                { key: "Active window", value: toDisplayValue(observation.activeWindowTitle) },
                { key: "Screenshot ref", value: toDisplayValue(observation.screenshotRef) }
              ]}
            />

            {observation.screenshotUrl ? (
              <div className="stack">
                <strong>Screenshot</strong>
                <a href={observation.screenshotUrl} target="_blank" rel="noreferrer">
                  <img
                    alt={`Run ${run.data?.id ?? runId} evidence screenshot`}
                    src={observation.screenshotUrl}
                    style={screenshotStyle}
                  />
                </a>
              </div>
            ) : null}

            <div className="stack">
              <strong>Focused element</strong>
              {observation.focusedElement ? (
                <KeyValueList entries={toObservationEntries(observation.focusedElement)} />
              ) : (
                <div className="empty-state">No focused element captured in the latest observation.</div>
              )}
            </div>

            <div className="stack">
              <strong>OCR text</strong>
              {observation.ocrText && observation.ocrText.length > 0 ? (
                <pre className="code-block">{observation.ocrText.join("\n")}</pre>
              ) : (
                <div className="empty-state">No OCR tokens were retained in this snapshot.</div>
              )}
            </div>

            <div className="stack">
              <strong>Recent observation events</strong>
              {observation.recentEvents && observation.recentEvents.length > 0 ? (
                <pre className="code-block">{observation.recentEvents.map(formatObservationEvent).join("\n")}</pre>
              ) : (
                <div className="empty-state">No recent AX/window events were retained.</div>
              )}
            </div>

            <div className="stack">
              <strong>Candidate preview</strong>
              {observation.candidatePreview && observation.candidatePreview.length > 0 ? (
                <pre className="code-block">{observation.candidatePreview.map(formatObservationElement).join("\n")}</pre>
              ) : (
                <div className="empty-state">No candidate preview available for this run.</div>
              )}
            </div>
          </div>
        ) : (
          <div className="empty-state">No retained observation evidence for this run yet.</div>
        )}
      </Card>

      <Card title="Event timeline" subtitle="Append-only event stream behind the Telegram status card and UI timeline.">
        <Timeline events={events.data ?? []} />
      </Card>

      <Card title="Raw payloads" subtitle="Useful while the API contract is still settling.">
        <pre className="code-block">{JSON.stringify({ run: run.data ?? null, events: events.data ?? [] }, null, 2)}</pre>
      </Card>
    </div>
  );
}

function toObservationEntries(element: AdminObservationElement) {
  return [
    { key: "Label", value: toDisplayValue(element.label) },
    { key: "Role", value: toDisplayValue(element.role) },
    { key: "Value", value: toDisplayValue(element.value) },
    { key: "Source", value: toDisplayValue(element.source) },
    { key: "Focused", value: toDisplayValue(element.focused) },
    { key: "Confidence", value: formatConfidence(element.confidence) }
  ];
}

function formatObservationEvent(event: AdminObservationEvent) {
  return `${formatDateTime(event.createdAt)}  ${event.kind}  ${event.message}`;
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

function formatConfidence(value: number | undefined) {
  return typeof value === "number" ? value.toFixed(2) : "n/a";
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

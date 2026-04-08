import type { AdminRunEvent } from "../lib/adminApi";
import { formatDateTime } from "../lib/format";

export function Timeline({ events }: { events: AdminRunEvent[] }) {
  if (events.length === 0) {
    return <div className="empty-state">No run events yet.</div>;
  }

  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id} className="timeline__item">
          <div className="timeline__time">{formatDateTime(event.createdAt)}</div>
          <div className="timeline__content">
            <strong>{event.kind}</strong>
            <p>{event.message || "No event message provided."}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

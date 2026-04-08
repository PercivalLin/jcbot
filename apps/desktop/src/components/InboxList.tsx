import type { InboxItem } from "@lobster/shared";

export function InboxList({ items }: { items: InboxItem[] }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {items.map((item) => (
        <article
          key={item.itemId}
          style={{
            padding: 14,
            borderRadius: 16,
            background: "#eef8ff",
            border: "1px solid #c4ddf2"
          }}
        >
          <strong>{item.sourceApp}</strong>
          <div style={{ marginTop: 8 }}>{item.summary}</div>
          <div style={{ fontSize: 13, color: "#466071", marginTop: 8 }}>
            {item.priority} | {item.state}
          </div>
        </article>
      ))}
      {items.length === 0 ? <span style={{ color: "#6b5d46" }}>Inbox is empty.</span> : null}
    </div>
  );
}


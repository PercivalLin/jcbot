import type { ApprovalTicket } from "@lobster/shared";

export function ApprovalList(props: {
  approvals: ApprovalTicket[];
  onApprove(ticketId: string): Promise<void>;
  onDeny(ticketId: string): Promise<void>;
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {props.approvals.map((ticket) => (
        <article
          key={ticket.id}
          style={{
            padding: 14,
            borderRadius: 16,
            background: "#fff3dd",
            border: "1px solid #f0cf8d"
          }}
        >
          <strong>{ticket.action.kind}</strong>
          <div style={{ fontSize: 13, marginTop: 8 }}>{ticket.reason}</div>
          <div style={{ fontSize: 12, marginTop: 8, color: "#8d6f40" }}>state: {ticket.state}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button disabled={ticket.state !== "pending"} onClick={() => void props.onApprove(ticket.id)}>
              Approve once
            </button>
            <button disabled={ticket.state !== "pending"} onClick={() => void props.onDeny(ticket.id)}>
              Deny
            </button>
          </div>
        </article>
      ))}
      {props.approvals.length === 0 ? (
        <span style={{ color: "#6b5d46" }}>No pending approvals.</span>
      ) : null}
    </div>
  );
}

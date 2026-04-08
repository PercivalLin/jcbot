export function BridgeCapabilities(props: {
  capabilities: {
    accessibility: boolean;
    eventTap: boolean;
    ocr: boolean;
    policyHardGate: boolean;
    screenCapture: boolean;
  } | null;
}) {
  if (!props.capabilities) {
    return <span style={{ color: "#6b5d46" }}>Bridge capabilities unavailable.</span>;
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {Object.entries(props.capabilities).map(([key, enabled]) => (
        <div
          key={key}
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderRadius: 14,
            background: enabled ? "#eef9f0" : "#fff5f1",
            border: enabled ? "1px solid #c9e7ce" : "1px solid #f2d3c7"
          }}
        >
          <span>{key}</span>
          <strong>{enabled ? "ready" : "off"}</strong>
        </div>
      ))}
    </div>
  );
}

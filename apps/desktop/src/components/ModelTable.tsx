import type { ModelProfile } from "@lobster/shared";

export function ModelTable(props: { models: Record<ModelProfile["role"], ModelProfile> | null }) {
  if (!props.models) {
    return <span style={{ color: "#6b5d46" }}>No model profiles loaded.</span>;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th align="left">Role</th>
          <th align="left">Provider</th>
          <th align="left">Model</th>
          <th align="left">Timeout</th>
        </tr>
      </thead>
      <tbody>
        {Object.values(props.models).map((model) => (
          <tr key={model.role}>
            <td>{model.role}</td>
            <td>{model.provider}</td>
            <td>{model.modelId}</td>
            <td>{model.timeoutMs}ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}


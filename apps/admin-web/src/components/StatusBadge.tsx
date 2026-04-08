export function StatusBadge({
  tone,
  label
}: {
  tone: "neutral" | "ok" | "warn" | "fail" | "accent";
  label: string;
}) {
  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}

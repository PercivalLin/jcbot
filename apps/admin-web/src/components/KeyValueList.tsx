export function KeyValueList({ entries }: { entries: Array<{ key: string; value: string }> }) {
  return (
    <dl className="key-value-list">
      {entries.map((entry) => (
        <div key={entry.key} className="key-value-list__row">
          <dt>{entry.key}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

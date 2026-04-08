export function formatDateTime(value: string | undefined) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function stringifyConfig(value: string | Record<string, unknown> | undefined) {
  if (typeof value === "string") {
    return value;
  }
  if (!value) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

export function toDisplayValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

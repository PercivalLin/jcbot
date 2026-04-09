import { createHash } from "node:crypto";
import type { DesktopAction, TargetDescriptor } from "@lobster/shared";

type CanonicalTargetDescriptor = {
  bounds?:
    | {
        height: number;
        width: number;
        x: number;
        y: number;
      }
    | undefined;
  candidateId: string;
  label: string;
  observationId?: string | undefined;
  role?: string | undefined;
  screenshotRef?: string | undefined;
  snapshotAt?: string | undefined;
  source: TargetDescriptor["source"];
};

type CanonicalActionFingerprintPayload = {
  actionId: string;
  args: DesktopAction["args"];
  kind: string;
  target?: string | undefined;
  targetDescriptor?: CanonicalTargetDescriptor | undefined;
};

export function canonicalizeTargetDescriptor(
  descriptor: Pick<
    TargetDescriptor,
    "bounds" | "candidateId" | "label" | "observationId" | "role" | "screenshotRef" | "snapshotAt" | "source"
  > | null | undefined
): CanonicalTargetDescriptor | undefined {
  if (!descriptor) {
    return undefined;
  }

  return {
    bounds: descriptor.bounds
      ? {
          height: descriptor.bounds.height,
          width: descriptor.bounds.width,
          x: descriptor.bounds.x,
          y: descriptor.bounds.y
        }
      : undefined,
    candidateId: descriptor.candidateId,
    label: descriptor.label,
    observationId: descriptor.observationId,
    role: descriptor.role,
    screenshotRef: descriptor.screenshotRef,
    snapshotAt: descriptor.snapshotAt,
    source: descriptor.source
  };
}

export function canonicalizeActionFingerprintPayload(action: DesktopAction): CanonicalActionFingerprintPayload {
  const canonicalArgs = { ...(action.args ?? {}) };
  delete canonicalArgs.targetDescriptor;

  return {
    actionId: action.id,
    args: canonicalArgs,
    kind: action.kind,
    target: action.target,
    targetDescriptor: canonicalizeTargetDescriptor(action.targetDescriptor)
  };
}

export function fingerprintCanonicalAction(action: DesktopAction): string {
  return createHash("sha256")
    .update(serializeCanonicalValue(canonicalizeActionFingerprintPayload(action)))
    .digest("hex");
}

export function hasCanonicalTargetDescriptorProvenance(
  descriptor: Pick<TargetDescriptor, "observationId" | "screenshotRef" | "snapshotAt"> | null | undefined
): descriptor is TargetDescriptor & { observationId: string; screenshotRef: string; snapshotAt: string } {
  return Boolean(
    descriptor?.observationId?.trim() &&
      descriptor.screenshotRef?.trim() &&
      descriptor.snapshotAt?.trim()
  );
}

export function serializeCanonicalValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalValue(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${serializeCanonicalValue(entryValue)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

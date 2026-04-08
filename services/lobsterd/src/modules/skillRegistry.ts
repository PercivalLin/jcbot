import { randomUUID } from "node:crypto";
import type { CapabilityCandidate, SkillManifest } from "@lobster/shared";
import { STARTER_SKILLS, isAutoPromotableCandidate } from "@lobster/skills";

export type RegistrySnapshot = {
  starter: SkillManifest[];
  staging: CapabilityCandidate[];
  stable: CapabilityCandidate[];
  held: CapabilityCandidate[];
};

export class SkillRegistry {
  private readonly starter = [...STARTER_SKILLS];
  private readonly staging: CapabilityCandidate[] = [];
  private readonly stable: CapabilityCandidate[] = [];
  private readonly held: CapabilityCandidate[] = [];

  hydrate(candidates: CapabilityCandidate[]) {
    this.staging.splice(0, this.staging.length);
    this.stable.splice(0, this.stable.length);
    this.held.splice(0, this.held.length);

    for (const candidate of candidates) {
      if (candidate.promotionState === "staging") {
        this.staging.push(candidate);
      } else if (candidate.promotionState === "stable") {
        this.stable.push(candidate);
      } else {
        this.held.push(candidate);
      }
    }
  }

  snapshot(): RegistrySnapshot {
    return {
      starter: [...this.starter],
      staging: [...this.staging],
      stable: [...this.stable],
      held: [...this.held]
    };
  }

  stageCandidate(candidate: CapabilityCandidate | Omit<CapabilityCandidate, "id" | "promotionState">) {
    const normalized: CapabilityCandidate =
      "id" in candidate
        ? candidate
        : ({
            id: randomUUID(),
            promotionState: "draft",
            ...candidate
          } satisfies CapabilityCandidate);

    const resolvedState =
      normalized.promotionState === "draft"
        ? isAutoPromotableCandidate({
            ...normalized,
            promotionState: "draft"
          })
          ? "staging"
          : "held"
        : normalized.promotionState;

    const fullCandidate: CapabilityCandidate = {
      ...normalized,
      promotionState: resolvedState
    };

    if (fullCandidate.promotionState === "staging") {
      this.staging.push(fullCandidate);
    } else if (fullCandidate.promotionState === "stable") {
      this.stable.push(fullCandidate);
    } else if (fullCandidate.promotionState === "rejected") {
      this.held.push(fullCandidate);
    } else {
      this.held.push(fullCandidate);
    }

    return fullCandidate;
  }

  promoteStaging(id: string) {
    return this.reviewStaging(id, true);
  }

  reviewStaging(id: string, observationWindowPassed: boolean, notes?: string) {
    const candidate = this.staging.find((item) => item.id === id);
    if (!candidate) {
      return undefined;
    }

    this.staging.splice(
      this.staging.findIndex((item) => item.id === id),
      1
    );

    if (observationWindowPassed) {
      candidate.promotionState = "stable";
      candidate.reason = notes ? `${candidate.reason} ${notes}` : candidate.reason;
      this.stable.push(candidate);
      return candidate;
    }

    candidate.promotionState = "held";
    candidate.reason = `${candidate.reason} Observation window review failed.${notes ? ` ${notes}` : ""}`;
    this.held.push(candidate);
    return candidate;
  }
}

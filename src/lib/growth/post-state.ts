import type { GrowthPostStatus } from "./types";

/** Allowed post lifecycle transitions. Anything not listed is rejected. */
export const POST_TRANSITIONS: Record<GrowthPostStatus, readonly GrowthPostStatus[]> = {
  idea: ["drafted", "archived"],
  drafted: ["review", "archived"],
  review: ["approved", "scheduled", "drafted", "archived"],
  approved: ["scheduled", "review", "archived"],
  scheduled: ["publishing", "review", "archived"],
  publishing: ["published", "failed", "scheduled"],
  published: ["archived"],
  failed: ["scheduled", "publishing", "review", "archived"],
  archived: [],
};

export function canTransition(from: GrowthPostStatus, to: GrowthPostStatus): boolean {
  return POST_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: GrowthPostStatus, to: GrowthPostStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid growth post transition: ${from} -> ${to}`);
}

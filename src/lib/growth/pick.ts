import type { GrowthIdea } from "./types";

/** Effective weight: stored weight, divided down by how often the idea has been used. */
export function effectiveWeight(idea: Pick<GrowthIdea, "weight" | "usedCount">): number {
  return Math.max(0, idea.weight) / (1 + idea.usedCount);
}

/** Weighted sampling without replacement. Pure; `rand` injectable for tests. */
export function pickWeighted(ideas: GrowthIdea[], n: number, rand: () => number = Math.random): GrowthIdea[] {
  const pool = ideas.filter((i) => effectiveWeight(i) > 0);
  const out: GrowthIdea[] = [];
  while (out.length < n && pool.length > 0) {
    const total = pool.reduce((s, i) => s + effectiveWeight(i), 0);
    let r = rand() * total;
    let idx = pool.length - 1;
    for (let k = 0; k < pool.length; k++) {
      r -= effectiveWeight(pool[k]);
      if (r < 0) {
        idx = k;
        break;
      }
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

import { describe, expect, it } from "vitest";
import { pickFresh, pickWeighted, effectiveWeight } from "@/lib/growth/pick";
import { SEED_IDEAS } from "@/lib/growth/seed-ideas";
import { GROWTH_ANGLES, type GrowthIdea } from "@/lib/growth/types";

const idea = (id: string, weight = 1, usedCount = 0): GrowthIdea => ({
  id, title: id, angle: "feature", format: "text", notes: null, weight, source: "seed", usedCount, createdAt: "", updatedAt: "",
});

describe("idea picking", () => {
  it("seeds 24 ideas across all five angles", () => {
    expect(SEED_IDEAS).toHaveLength(24);
    expect(new Set(SEED_IDEAS.map((i) => i.angle))).toEqual(new Set(GROWTH_ANGLES));
  });
  it("returns n distinct ideas and never more than exist", () => {
    const ideas = [idea("a"), idea("b"), idea("c")];
    const got = pickWeighted(ideas, 5);
    expect(new Set(got.map((i) => i.id)).size).toBe(3);
    expect(pickWeighted(ideas, 2)).toHaveLength(2);
  });
  it("penalises used ideas and skips zero weight", () => {
    expect(effectiveWeight(idea("x", 1, 3))).toBe(0.25);
    expect(pickWeighted([idea("z", 0)], 1)).toEqual([]);
    // rand ~0 picks the first heavy idea; used idea is lighter so a high rand lands on the fresh one
    const pool = [idea("used", 1, 9), idea("fresh", 1, 0)];
    expect(pickWeighted(pool, 1, () => 0.5)[0].id).toBe("fresh");
  });
  it("skips ideas recently used by a post when fresh ideas remain", () => {
    const ideas = [idea("approve"), idea("clauses"), idea("fresh-1"), idea("fresh-2")];
    const recent = new Set(["approve", "clauses"]);
    for (const r of [0, 0.3, 0.7, 0.999]) {
      const got = pickFresh(ideas, 2, recent, () => r).map((i) => i.id);
      expect(got.sort()).toEqual(["fresh-1", "fresh-2"]);
    }
  });
  it("falls back to penalised weighting only when fewer than n fresh ideas remain", () => {
    const ideas = [idea("approve"), idea("clauses"), idea("fresh")];
    const recent = new Set(["approve", "clauses"]);
    const got = pickFresh(ideas, 2, recent, () => 0.5).map((i) => i.id);
    expect(got[0]).toBe("fresh");
    expect(got).toHaveLength(2);
    expect(new Set(got).size).toBe(2);
  });
  it("does not mutate the exclusion set and returns all ideas when none are excluded", () => {
    const ideas = [idea("a"), idea("b")];
    const recent = new Set<string>();
    expect(pickFresh(ideas, 2, recent, () => 0.1)).toHaveLength(2);
    expect(recent.size).toBe(0);
  });
});

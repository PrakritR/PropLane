import { describe, expect, it } from "vitest";
import {
  APP_REVIEW_RULES,
  applyAnswer,
  applyAppLaunch,
  applyPromptShown,
  emptyAppReviewState,
  parseAppReviewState,
  routeForStars,
  shouldOfferAppReview,
  type AppReviewState,
} from "@/lib/native/app-review-eligibility";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

/** A device that clears every threshold: installed 4 days ago, opened 5 times, never asked. */
function eligible(overrides: Partial<AppReviewState> = {}): AppReviewState {
  return { ...emptyAppReviewState(T0 - 4 * DAY), opens: 5, ...overrides };
}

const ok = { pluginAvailable: true };

describe("shouldOfferAppReview", () => {
  it("offers on a device that clears every threshold", () => {
    expect(shouldOfferAppReview(eligible(), T0, ok)).toBe(true);
  });

  it("never offers without the native review plugin", () => {
    expect(shouldOfferAppReview(eligible(), T0, { pluginAvailable: false })).toBe(false);
  });

  it("waits three full days after the first open", () => {
    const justUnder = eligible({ firstOpenAt: T0 - (3 * DAY - 1) });
    const exactly = eligible({ firstOpenAt: T0 - 3 * DAY });
    expect(shouldOfferAppReview(justUnder, T0, ok)).toBe(false);
    expect(shouldOfferAppReview(exactly, T0, ok)).toBe(true);
  });

  it("waits for the fifth open", () => {
    expect(shouldOfferAppReview(eligible({ opens: 4 }), T0, ok)).toBe(false);
    expect(shouldOfferAppReview(eligible({ opens: 5 }), T0, ok)).toBe(true);
  });

  it("never asks more than three times on one device", () => {
    const spent = eligible({ promptCount: APP_REVIEW_RULES.maxLifetimePrompts, lastPromptAt: T0 - 400 * DAY });
    expect(shouldOfferAppReview(spent, T0, ok)).toBe(false);
  });

  it("keeps ninety days between two sheets even with no answer recorded", () => {
    const recent = eligible({ promptCount: 1, lastPromptAt: T0 - 89 * DAY });
    const old = eligible({ promptCount: 1, lastPromptAt: T0 - 90 * DAY });
    expect(shouldOfferAppReview(recent, T0, ok)).toBe(false);
    expect(shouldOfferAppReview(old, T0, ok)).toBe(true);
  });

  it("a 4–5 star pick is terminal", () => {
    const rated = applyAnswer(applyPromptShown(eligible(), T0 - 400 * DAY), { kind: "stars", stars: 5 }, T0 - 400 * DAY);
    expect(shouldOfferAppReview(rated, T0, ok)).toBe(false);
  });

  it("a 1–3 star pick is quiet for 180 days, then may ask again", () => {
    const at = T0 - 100 * DAY;
    const low = applyAnswer(applyPromptShown(eligible({ firstOpenAt: at - 4 * DAY }), at), { kind: "stars", stars: 2 }, at);
    expect(shouldOfferAppReview(low, at + 179 * DAY, ok)).toBe(false);
    expect(shouldOfferAppReview(low, at + 180 * DAY, ok)).toBe(true);
  });

  it("not now is quiet for 30 days, but the 90-day gap between sheets still wins", () => {
    const at = T0 - 100 * DAY;
    const later = applyAnswer(applyPromptShown(eligible({ firstOpenAt: at - 4 * DAY }), at), { kind: "later" }, at);
    expect(shouldOfferAppReview(later, at + 29 * DAY, ok)).toBe(false);
    // 30 days clears the answer cooldown but not the gap between two sheets.
    expect(shouldOfferAppReview(later, at + 30 * DAY, ok)).toBe(false);
    expect(shouldOfferAppReview(later, at + 90 * DAY, ok)).toBe(true);
  });
});

describe("state transitions", () => {
  it("counts opens", () => {
    expect(applyAppLaunch(emptyAppReviewState(T0)).opens).toBe(1);
  });

  it("records a shown sheet", () => {
    const shown = applyPromptShown(eligible(), T0);
    expect(shown.promptCount).toBe(1);
    expect(shown.lastPromptAt).toBe(T0);
  });

  it("clamps stars to 1–5 and routes 4+ to the store", () => {
    expect(applyAnswer(eligible(), { kind: "stars", stars: 9 }, T0).stars).toBe(5);
    expect(applyAnswer(eligible(), { kind: "stars", stars: 0 }, T0).stars).toBe(1);
    expect(routeForStars(3)).toBe("feedback");
    expect(routeForStars(4)).toBe("store");
    expect(applyAnswer(eligible(), { kind: "stars", stars: 4 }, T0).lastAnswer).toBe("store");
    expect(applyAnswer(eligible(), { kind: "stars", stars: 3 }, T0).lastAnswer).toBe("feedback");
  });
});

describe("parseAppReviewState", () => {
  it("round-trips a valid record", () => {
    const state = applyAnswer(applyPromptShown(eligible(), T0), { kind: "stars", stars: 4 }, T0);
    expect(parseAppReviewState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects anything malformed so a corrupt record can never make a device eligible", () => {
    expect(parseAppReviewState(null)).toBeNull();
    expect(parseAppReviewState("nope")).toBeNull();
    expect(parseAppReviewState({})).toBeNull();
    expect(parseAppReviewState({ ...eligible(), opens: "5" })).toBeNull();
    expect(parseAppReviewState({ ...eligible(), stars: 6 })).toBeNull();
    expect(parseAppReviewState({ ...eligible(), lastAnswer: "yes" })).toBeNull();
    expect(parseAppReviewState({ ...eligible(), firstOpenAt: -1 })).toBeNull();
  });
});

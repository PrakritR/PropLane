/**
 * Pure rules for the in-app "Enjoying PropLane?" rating sheet. No `window`,
 * no Capacitor — every decision here is a function of a small per-device
 * record plus `now`, so the whole contract is unit-testable and the UI in
 * `src/components/native/rate-app-prompt.tsx` only ever asks two questions:
 * "may I show it?" and "what happens after this answer?".
 *
 * The record lives in localStorage under {@link APP_REVIEW_STORAGE_KEY}
 * (see `app-review.ts`). Apple additionally caps its own star sheet at three
 * shows per 365 days per device and honours the user's "In-App Ratings"
 * switch; these rules sit on top so the PropLane sheet itself never nags.
 */

/** Something that just went right for the user — the only moments we ask on. */
export type AppReviewMoment = "listing_published" | "charge_paid" | "lease_signed";

export const APP_REVIEW_MOMENTS: readonly AppReviewMoment[] = ["listing_published", "charge_paid", "lease_signed"];

export type AppReviewState = {
  /** First open of the native shell on this device, epoch ms. */
  firstOpenAt: number;
  /** Launches + foreground resumes of the native shell on this device. */
  opens: number;
  /** When the PropLane sheet was last shown, epoch ms (0 = never). */
  lastPromptAt: number;
  /** How many times the PropLane sheet has been shown, ever. */
  promptCount: number;
  /** Last star pick, 1–5 (0 = never picked). */
  stars: number;
  /** When the last answer (stars or "not now") was given, epoch ms (0 = never). */
  answeredAt: number;
  /** Last answer route, so the cooldown can differ by outcome. */
  lastAnswer: "store" | "feedback" | "later" | null;
};

export const APP_REVIEW_STORAGE_KEY = "proplane:app-review:v1";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thresholds — the numbers the plan and the unit test both pin. */
export const APP_REVIEW_RULES = {
  /** Never on a fresh install (Apple HIG: not on first launch / onboarding). */
  minInstallAgeMs: 3 * DAY_MS,
  /** They need a real opinion first. */
  minOpens: 5,
  /** The sheet itself must never be the nag. */
  minGapBetweenPromptsMs: 90 * DAY_MS,
  maxLifetimePrompts: 3,
  /** "Not now" → polite retry. */
  laterCooldownMs: 30 * DAY_MS,
  /** 1–3 stars → they told us once; not again this season. */
  feedbackCooldownMs: 180 * DAY_MS,
  /** The star pick that is good enough to send to the App Store. */
  storeThresholdStars: 4,
} as const;

export function emptyAppReviewState(now: number): AppReviewState {
  return {
    firstOpenAt: now,
    opens: 0,
    lastPromptAt: 0,
    promptCount: 0,
    stars: 0,
    answeredAt: 0,
    lastAnswer: null,
  };
}

/**
 * Parse whatever was in storage. Anything malformed becomes `null` so the
 * caller starts fresh — a corrupt record must never make someone eligible.
 */
export function parseAppReviewState(raw: unknown): AppReviewState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const firstOpenAt = num(r.firstOpenAt);
  const opens = num(r.opens);
  const lastPromptAt = num(r.lastPromptAt);
  const promptCount = num(r.promptCount);
  const stars = num(r.stars);
  const answeredAt = num(r.answeredAt);
  const lastAnswer = r.lastAnswer;
  if (
    firstOpenAt === null ||
    opens === null ||
    lastPromptAt === null ||
    promptCount === null ||
    stars === null ||
    stars > 5 ||
    answeredAt === null ||
    !(lastAnswer === null || lastAnswer === "store" || lastAnswer === "feedback" || lastAnswer === "later")
  ) {
    return null;
  }
  return { firstOpenAt, opens, lastPromptAt, promptCount, stars, answeredAt, lastAnswer };
}

export function applyAppLaunch(state: AppReviewState): AppReviewState {
  return { ...state, opens: state.opens + 1 };
}

/** Which route a star pick takes. */
export function routeForStars(stars: number): "store" | "feedback" {
  return stars >= APP_REVIEW_RULES.storeThresholdStars ? "store" : "feedback";
}

/**
 * Whether the PropLane sheet may be shown right now. `pluginAvailable` is the
 * native review plugin probe — an older shell without it must never get a
 * dead "Rate on the App Store" button, so it is a hard gate rather than a
 * runtime fallback.
 */
export function shouldOfferAppReview(
  state: AppReviewState,
  now: number,
  opts: { pluginAvailable: boolean },
): boolean {
  if (!opts.pluginAvailable) return false;
  if (now - state.firstOpenAt < APP_REVIEW_RULES.minInstallAgeMs) return false;
  if (state.opens < APP_REVIEW_RULES.minOpens) return false;
  if (state.promptCount >= APP_REVIEW_RULES.maxLifetimePrompts) return false;
  if (state.lastPromptAt && now - state.lastPromptAt < APP_REVIEW_RULES.minGapBetweenPromptsMs) return false;
  // A good rating is terminal: Apple handles any re-ask on its side.
  if (state.lastAnswer === "store") return false;
  if (state.lastAnswer === "feedback" && now - state.answeredAt < APP_REVIEW_RULES.feedbackCooldownMs) return false;
  if (state.lastAnswer === "later" && now - state.answeredAt < APP_REVIEW_RULES.laterCooldownMs) return false;
  return true;
}

export function applyPromptShown(state: AppReviewState, now: number): AppReviewState {
  return { ...state, lastPromptAt: now, promptCount: state.promptCount + 1 };
}

export function applyAnswer(
  state: AppReviewState,
  answer: { kind: "stars"; stars: number } | { kind: "later" },
  now: number,
): AppReviewState {
  if (answer.kind === "later") return { ...state, answeredAt: now, lastAnswer: "later" };
  const stars = Math.min(5, Math.max(1, Math.round(answer.stars)));
  return { ...state, stars, answeredAt: now, lastAnswer: routeForStars(stars) };
}

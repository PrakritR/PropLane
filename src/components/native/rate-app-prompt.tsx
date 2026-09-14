"use client";

import { Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { VaulBottomSheet } from "@/components/ui/vaul-bottom-sheet";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalFeedbackSubmitModal } from "@/components/portal/portal-feedback-submit-modal";
import { usePortalSession } from "@/hooks/use-portal-session";
import { track } from "@/lib/analytics/track-client";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import {
  APP_REVIEW_OFFER_EVENT,
  isAppReviewPluginAvailable,
  markAppReviewAnswer,
  markAppReviewPromptShown,
  readAppReviewState,
  requestNativeReview,
  type AppReviewOfferDetail,
} from "@/lib/native/app-review";
import { routeForStars, shouldOfferAppReview, type AppReviewMoment } from "@/lib/native/app-review-eligibility";
import type { BugFeedbackReporterRole } from "@/lib/portal-bug-feedback";
import { cn } from "@/lib/utils";

/** Delay after the moment's own success toast, so the sheet never races it. */
const OFFER_DELAY_MS = 1500;

const MOMENT_LINE: Record<AppReviewMoment, string> = {
  listing_published: "Your listing is live.",
  charge_paid: "Rent's taken care of.",
  lease_signed: "Lease signed — nice.",
};

const STAR_HINT: Record<number, string> = {
  0: "Tap a star",
  1: "Sorry to hear it — tell us what to fix",
  2: "Sorry to hear it — tell us what to fix",
  3: "Thanks — what would make it better?",
  4: "Great — would you say so on the App Store?",
  5: "Great — would you say so on the App Store?",
};

/**
 * Another sheet or modal already on screen: skip this moment rather than
 * stack. The next good moment re-arms it.
 */
function somethingElseIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[data-vaul-drawer], [role="dialog"][data-state="open"]'));
}

/**
 * "Enjoying PropLane?" — the in-app rating sheet. Native shell only; renders
 * nothing on the web. Wakes on {@link APP_REVIEW_OFFER_EVENT} (a delight
 * moment fired through `recordDelightMoment`), checks the per-device rules,
 * and shows five stars: 4–5 hand off to the OS's own rating sheet, 1–3 open
 * the existing feedback form pre-titled so the reason comes to us.
 */
export function RateAppPrompt({ reporterRole }: { reporterRole: BugFeedbackReporterRole }) {
  const [isNative, setIsNative] = useState(false);
  const [open, setOpen] = useState(false);
  const [moment, setMoment] = useState<AppReviewMoment>("listing_published");
  const [stars, setStars] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { showToast } = useAppUi();
  const session = usePortalSession();
  const timer = useRef<number | null>(null);
  // Set once an answer is recorded, so the sheet's own close (drag, overlay,
  // ✕) after a submit does not also record a "not now".
  const answered = useRef(false);

  useEffect(() => {
    // Deferred so SSR and the web render the "nothing" branch identically.
    void Promise.resolve().then(() => setIsNative(isNativeRuntimeSync()));
  }, []);

  useEffect(() => {
    if (!isNative) return;
    const onOffer = (event: Event) => {
      const detail = (event as CustomEvent<AppReviewOfferDetail>).detail;
      if (!detail?.moment) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void (async () => {
          if (document.visibilityState !== "visible" || somethingElseIsOpen()) return;
          const pluginAvailable = await isAppReviewPluginAvailable();
          if (!shouldOfferAppReview(readAppReviewState(), Date.now(), { pluginAvailable })) return;
          markAppReviewPromptShown();
          track("app_review_prompted", { moment: detail.moment });
          answered.current = false;
          setMoment(detail.moment);
          setStars(0);
          setOpen(true);
        })();
      }, OFFER_DELAY_MS);
    };
    window.addEventListener(APP_REVIEW_OFFER_EVENT, onOffer);
    return () => {
      window.removeEventListener(APP_REVIEW_OFFER_EVENT, onOffer);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [isNative]);

  const dismiss = useCallback(() => {
    if (answered.current) return;
    answered.current = true;
    markAppReviewAnswer({ kind: "later" });
    track("app_review_answered", { stars: 0, route: "later" });
    setOpen(false);
  }, []);

  const submit = useCallback(async () => {
    if (!stars || answered.current) return;
    answered.current = true;
    const route = routeForStars(stars);
    markAppReviewAnswer({ kind: "stars", stars });
    track("app_review_answered", { stars, route });
    setOpen(false);
    if (route === "feedback") {
      setFeedbackOpen(true);
      return;
    }
    // Apple never says whether it drew its sheet; either way the device is done.
    const asked = await requestNativeReview();
    track("app_review_requested", { shown: asked });
    if (!asked) showToast("Thanks!");
  }, [stars, showToast]);

  if (!isNative) return null;

  return (
    <>
      <VaulBottomSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) dismiss();
        }}
        title={<span className="sr-only">Enjoying PropLane?</span>}
        assistantStrip={false}
      >
        <div className="px-2 pb-2 pt-3 text-center" data-testid="rate-app-prompt">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Enjoying PropLane?</h2>
          <p className="mx-auto mt-1.5 max-w-[30ch] text-base text-muted">
            {MOMENT_LINE[moment]} We&apos;re a small team building this — a rating goes a really long way.
          </p>
          <div className="mt-4 flex justify-center gap-1.5" role="radiogroup" aria-label="Rate 1 to 5 stars">
            {[1, 2, 3, 4, 5].map((n) => {
              const on = n <= stars;
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={stars === n}
                  aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  className="flex h-[54px] w-[54px] items-center justify-center rounded-full active:scale-95"
                  data-attr={`rate-app-star-${n}`}
                  onClick={() => setStars(n)}
                >
                  <Star
                    className={cn("h-11 w-11 transition-colors", on ? "fill-primary text-primary" : "text-foreground/25")}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </button>
              );
            })}
          </div>
          <p className={cn("mt-1 min-h-5 text-sm", stars >= 4 ? "text-emerald-700" : "text-muted")} aria-live="polite">
            {STAR_HINT[stars]}
          </p>
          <div className="mt-4 flex flex-col gap-2.5">
            <Button
              type="button"
              variant="primary"
              className="h-[52px] rounded-full text-[17px]"
              disabled={!stars}
              data-attr="rate-app-submit"
              onClick={() => submit()}
            >
              {!stars ? "Submit" : stars >= 4 ? "Rate on the App Store" : "Tell us what to fix"}
            </Button>
            <Button type="button" variant="ghost" className="h-10 rounded-full" data-attr="rate-app-later" onClick={dismiss}>
              Not now
            </Button>
          </div>
        </div>
      </VaulBottomSheet>

      <PortalFeedbackSubmitModal
        key={stars}
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        reporterRole={reporterRole}
        reporterUserId={session.userId}
        reporterEmail={session.email ?? ""}
        reporterName={session.email ?? ""}
        initialTitle={stars ? `Rated ${stars}/5 in the app` : ""}
        onSubmitted={() => {}}
      />
    </>
  );
}

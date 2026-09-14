// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = { on: false };
vi.mock("@/lib/native/detect-native", () => ({
  isNativeRuntimeSync: () => native.on,
  detectNativePlatformSync: () => (native.on ? "ios" : null),
}));

const review = {
  pluginAvailable: true,
  eligible: true,
  requestNativeReview: vi.fn(async () => true),
  markAppReviewPromptShown: vi.fn(),
  markAppReviewAnswer: vi.fn(),
};
vi.mock("@/lib/native/app-review", () => ({
  APP_REVIEW_OFFER_EVENT: "proplane:app-review:offer",
  isAppReviewPluginAvailable: async () => review.pluginAvailable,
  readAppReviewState: () => ({ marker: "state" }),
  requestNativeReview: (...args: unknown[]) => review.requestNativeReview(...args),
  markAppReviewPromptShown: (...args: unknown[]) => review.markAppReviewPromptShown(...args),
  markAppReviewAnswer: (...args: unknown[]) => review.markAppReviewAnswer(...args),
}));
vi.mock("@/lib/native/app-review-eligibility", () => ({
  shouldOfferAppReview: () => review.eligible,
  routeForStars: (stars: number) => (stars >= 4 ? "store" : "feedback"),
}));

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u1", email: "m@example.com" }),
}));
const track = vi.fn();
vi.mock("@/lib/analytics/track-client", () => ({ track: (...args: unknown[]) => track(...args) }));

// The real sheet is vaul + Radix; in jsdom a plain container that mirrors `open` is enough.
vi.mock("@/components/ui/vaul-bottom-sheet", () => ({
  VaulBottomSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
}));
vi.mock("@/components/portal/portal-feedback-submit-modal", () => ({
  PortalFeedbackSubmitModal: ({ open, initialTitle }: { open: boolean; initialTitle?: string }) =>
    open ? <div data-testid="feedback-modal">{initialTitle}</div> : null,
}));

import { RateAppPrompt } from "@/components/native/rate-app-prompt";

function fireMoment(moment = "listing_published") {
  window.dispatchEvent(new CustomEvent("proplane:app-review:offer", { detail: { moment } }));
}

async function mountNativeAndOffer() {
  render(<RateAppPrompt reporterRole="manager" />);
  await act(async () => {});
  await act(async () => {
    fireMoment();
    await vi.advanceTimersByTimeAsync(1600);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  native.on = true;
  review.pluginAvailable = true;
  review.eligible = true;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("RateAppPrompt", () => {
  it("renders nothing on the web, even when a moment fires", async () => {
    native.on = false;
    await mountNativeAndOffer();
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(review.markAppReviewPromptShown).not.toHaveBeenCalled();
  });

  it("stays quiet when the device is not eligible", async () => {
    review.eligible = false;
    await mountNativeAndOffer();
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it("shows the sheet ~1.5s after a delight moment, with Submit disabled until a star is picked", async () => {
    render(<RateAppPrompt reporterRole="manager" />);
    await act(async () => {});
    await act(async () => {
      fireMoment();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByTestId("sheet")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByTestId("sheet")).toBeTruthy();
    expect(screen.getByText("Your listing is live.", { exact: false })).toBeTruthy();
    expect(review.markAppReviewPromptShown).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("app_review_prompted", { moment: "listing_published" });
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("4–5 stars → 'Rate on the App Store' → the OS review request, device marked done", async () => {
    await mountNativeAndOffer();
    fireEvent.click(screen.getByRole("radio", { name: "5 stars" }));
    const submit = screen.getByRole("button", { name: "Rate on the App Store" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(review.markAppReviewAnswer).toHaveBeenCalledWith({ kind: "stars", stars: 5 });
    expect(review.requestNativeReview).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("app_review_answered", { stars: 5, route: "store" });
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(screen.queryByTestId("feedback-modal")).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("thanks the user when the OS declines to draw its sheet", async () => {
    review.requestNativeReview.mockResolvedValueOnce(false);
    await mountNativeAndOffer();
    fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rate on the App Store" }));
    });
    expect(showToast).toHaveBeenCalledWith("Thanks!");
  });

  it("1–3 stars → 'Tell us what to fix' → the feedback form pre-titled", async () => {
    await mountNativeAndOffer();
    fireEvent.click(screen.getByRole("radio", { name: "2 stars" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tell us what to fix" }));
    });
    expect(review.markAppReviewAnswer).toHaveBeenCalledWith({ kind: "stars", stars: 2 });
    expect(review.requestNativeReview).not.toHaveBeenCalled();
    expect(screen.getByTestId("feedback-modal").textContent).toBe("Rated 2/5 in the app");
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("Not now records a later answer and closes", async () => {
    await mountNativeAndOffer();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    });
    expect(review.markAppReviewAnswer).toHaveBeenCalledWith({ kind: "later" });
    expect(track).toHaveBeenCalledWith("app_review_answered", { stars: 0, route: "later" });
    expect(screen.queryByTestId("sheet")).toBeNull();
  });
});

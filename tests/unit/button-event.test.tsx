// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Spy the posthog-js singleton the way instrumentation-client.ts loads it, so we
// assert on the exact payload the real Button -> track() -> posthog.capture path
// hands to PostHog. vi.mock is hoisted, so build the spy via vi.hoisted.
const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { capture } }));
vi.mock("@/lib/analytics/browser-performance", () => ({ isProductionAnalyticsHost: () => true }));

import { Button } from "@/components/ui/button";

describe("Button named-event wiring (the trivial-tracking deliverable)", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "test-token"));
  afterEach(() => {
    cleanup();
    capture.mockReset();
    vi.unstubAllEnvs();
  });

  it("fires the named PostHog event with props on click", async () => {
    render(
      <Button event="subscription_checkout_started" eventProps={{ tier: "pro", billing: "annual" }}>
        Upgrade
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith("subscription_checkout_started", {
      tier: "pro",
      billing: "annual",
    }));
  });

  it("still runs the caller's onClick alongside tracking", async () => {
    const onClick = vi.fn();
    render(
      <Button event="feedback_submitted" onClick={onClick}>
        Submit
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith("feedback_submitted", undefined));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("captures nothing when no event prop is set (opt-in only)", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Plain</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Plain" }));
    expect(capture).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

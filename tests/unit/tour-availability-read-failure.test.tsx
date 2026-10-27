// @vitest-environment jsdom
/**
 * "No tour times yet" is an affirmative claim
 * about the PROPERTY. A throttled or failed availability read says nothing about
 * the property at all, and the booking flow used to collapse both into the same
 * empty grid — so a prospect behind a shared NAT that trips the public route's
 * IP rate limit was shown a confident "no availability" for a house with a full
 * calendar, and left.
 *
 * Same invariant the resident tour panel holds
 * (`resident-tour-panel-load-failure.test.tsx`): a failed read is rendered as a
 * failed read, with a way to retry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockProperty } from "@/data/types";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      // The prospect-autofill hook subscribes as well as reads, so a mock with
      // only getSession throws on mount and fails every case here for a reason
      // that has nothing to do with tour availability. Same shape the other
      // browser-client mocks in this suite use.
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

import { TourScheduleFlow } from "@/components/marketing/tour-schedule-flow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROPERTY: MockProperty = {
  id: "mgr-ballard-1",
  title: "Ballard House",
  tagline: "Bright rooms near the locks",
  address: "1 Ballard Ave",
  zip: "98107",
  neighborhood: "Ballard",
  beds: 3,
  baths: 2,
  rentLabel: "$1,200/mo",
  available: "Now",
  petFriendly: true,
  buildingId: "mgr-ballard",
  buildingName: "Ballard House",
  unitLabel: "Room A",
};

const EMPTY_STATE = /No tour times yet/i;

/** Every availability fetch in one test, newest response last. */
function stubAvailability(responses: { ok: boolean; status: number; body: unknown }[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Render the flow and advance from the room step to the date & time step. */
async function renderAtDateStep() {
  render(<TourScheduleFlow property={PROPERTY} returnAfterAuth="/rent" onSuccess={() => {}} />);
  fireEvent.click(await screen.findByText(`${PROPERTY.buildingName} · ${PROPERTY.unitLabel}`));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("a failed tour-availability read is never a booking page with zero slots", () => {
  it("shows a try-again message rather than the empty state when the route throttles", async () => {
    stubAvailability([{ ok: false, status: 429, body: { error: "Too many requests. Please slow down." } }]);
    await renderAtDateStep();

    await waitFor(() => {
      expect(screen.getByText(/wait a moment and try again/i)).toBeTruthy();
    });
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows a try-again message when the read fails outright", async () => {
    stubAvailability([{ ok: false, status: 500, body: { error: "boom" } }]);
    await renderAtDateStep();

    await waitFor(() => {
      expect(screen.getByText(/couldn't load this property's tour windows/i)).toBeTruthy();
    });
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
  });

  it("recovers to the real grid when the retry succeeds", async () => {
    const day = "2099-08-06";
    const fetchMock = stubAvailability([
      { ok: false, status: 429, body: { error: "Too many requests. Please slow down." } },
      { ok: true, status: 200, body: { slotHosts: { [`${day}:20`]: [{ userId: "m1", label: "Manager" }] } } },
    ]);
    await renderAtDateStep();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("still treats a SUCCEEDED, empty read as the property's own answer (request mode, never a retry)", async () => {
    // The empty read is a real answer - the fix must not swallow it too. It no longer ends in a dead
    // "No tour times yet": the visitor is offered a requested time (signed out: asked to sign in first).
    stubAvailability([{ ok: true, status: 200, body: { slotHosts: {} } }]);
    await renderAtDateStep();

    await waitFor(() => {
      expect(screen.getByText(/Sign in to request a tour time/i)).toBeTruthy();
    });
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("treats a grid whose every published slot is already past as no open slots (request mode)", async () => {
    stubAvailability([{ ok: true, status: 200, body: { slotHosts: { "2001-01-02:4": [{ id: "m1", name: "Pat", email: "pat@example.com" }] } } }]);
    await renderAtDateStep();

    await waitFor(() => {
      expect(screen.getByText(/Sign in to request a tour time/i)).toBeTruthy();
    });
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
  });

  it("replaces the dead empty state with sign-in links into the resident portal, never a text link", async () => {
    stubAvailability([{ ok: true, status: 200, body: { slotHosts: {} } }]);
    render(
      <TourScheduleFlow
        property={{ ...PROPERTY, contactSmsPhone: "+12065550123" }}
        returnAfterAuth="/rent"
        onSuccess={() => {}}
      />,
    );
    fireEvent.click(await screen.findByText(`${PROPERTY.buildingName} · ${PROPERTY.unitLabel}`));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const signIn = await screen.findByText("Sign in");
    expect(signIn.closest("a")?.getAttribute("href")?.startsWith("sms:")).toBe(false);
    expect(screen.queryByText("Message the manager")).toBeNull();
  });
});

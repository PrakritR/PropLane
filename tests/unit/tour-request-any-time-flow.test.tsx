// @vitest-environment jsdom
/**
 * The booking flow for a house with NO open slot: every day from tomorrow is pickable with 30-minute times
 * 8:00 AM-7:30 PM, the pick is captioned "... · request", and submitting files `requestKind: "requested_time"`
 * without naming a host. A house WITH slots offers only those slots, as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockProperty } from "@/data/types";

const session = vi.hoisted(() => ({
  state: { ready: true, userId: "u1" as string | null, hasResidentRole: true, name: "Prakrit", email: "p@example.com", phone: "2065550123" },
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({ useProspectContactAutofill: () => session.state }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/tour-resident-link.client", () => ({ linkBookedToursToSignedInResident: async () => true }));
vi.mock("@/hooks/use-tour-application-gate", () => ({ useTourApplicationGate: () => ({ status: "ok" }) }));

import { TourScheduleFlow } from "@/components/marketing/tour-schedule-flow";
import { requestedTourDates } from "@/lib/tour-request-time";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.state.userId = "u1";
});

const PROPERTY: MockProperty = {
  id: "prop-1",
  title: "2412 Clifford St",
  tagline: "",
  address: "2412 Clifford St",
  zip: "98107",
  neighborhood: "Ballard",
  beds: 3,
  baths: 2,
  rentLabel: "$1,200/mo",
  available: "Now",
  petFriendly: true,
  buildingId: "b1",
  buildingName: "Clifford House",
  unitLabel: "Room A",
};

function stubFetch(slotHosts: Record<string, unknown[]>) {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/public/partner-inquiries")) {
        const body = JSON.parse(String(init?.body)) as { row: Record<string, unknown> };
        posts.push(body.row);
        return { ok: true, status: 200, json: async () => ({ ok: true, row: body.row }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ slotHosts }) } as unknown as Response;
    }),
  );
  return posts;
}

async function openDateStep() {
  render(<TourScheduleFlow property={PROPERTY} returnAfterAuth="/resident/tour" onSuccess={() => {}} />);
  fireEvent.click(await screen.findByText(`${PROPERTY.buildingName} · ${PROPERTY.unitLabel}`));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("tour request any time", () => {
  it("offers 60 days from tomorrow and 24 half-hour times, then captions the pick", async () => {
    stubFetch({});
    await openDateStep();
    const days = await screen.findAllByRole("button", { name: /request a tour$/ });
    expect(days).toHaveLength(60);
    fireEvent.click(days[1]!);
    const times = await waitFor(() => {
      const found = screen.getAllByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(times).toHaveLength(24);
    expect(times[0]!.textContent).toBe("8:00 AM");
    expect(times[times.length - 1]!.textContent).toBe("7:30 PM");
    fireEvent.click(times.find((t) => t.textContent === "4:00 PM")!);
    const caption = document.querySelector('[data-attr="tour-request-caption"]')!;
    expect(caption.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} at 4:00 PM · request$/);
    expect(screen.queryByText(/No tour times yet/i)).toBeNull();
  });

  it("files requestKind requested_time on the Pacific half hour, naming no host", async () => {
    const posts = stubFetch({});
    await openDateStep();
    const days = await screen.findAllByRole("button", { name: /request a tour$/ });
    fireEvent.click(days[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "4:00 PM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Book tour/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const row = posts[0]!;
    expect(row.requestKind).toBe("requested_time");
    expect(row.kind).toBe("tour");
    expect(row.managerUserId).toBeUndefined();
    const expectedDay = requestedTourDates()[1]!;
    const window = (row.requestedWindows as { slotKey: string; start: string }[])[0]!;
    expect(window.slotKey).toBe(`${expectedDay}:32`);
    // 4:00 PM Pacific is 23:00 UTC in PDT and 00:00 UTC (next day) in PST.
    expect(window.start).toMatch(/T(23|00):00:00\.000Z$/);
  });

  it("asks a signed-out visitor to sign in instead of showing a picker", async () => {
    session.state.userId = null;
    stubFetch({});
    await openDateStep();
    await screen.findByText("Sign in to request a tour time");
    expect(screen.queryAllByRole("button", { name: /request a tour$/ })).toHaveLength(0);
  });

  it("keeps slot-only booking when the house has open slots", async () => {
    stubFetch({ "2099-08-06:20": [{ userId: "m1", label: "Manager", propertyId: "prop-1" }] });
    await openDateStep();
    const days = await screen.findAllByRole("button", { name: /open for tours$/ });
    expect(days).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: /request a tour$/ })).toHaveLength(0);
    fireEvent.click(days[0]!);
    const times = await screen.findAllByRole("button", { name: /\d/ });
    expect(times.some((t) => t.textContent === "10 am")).toBe(true);
    expect(document.querySelector('[data-attr="tour-request-caption"]')).toBeNull();
  });
});

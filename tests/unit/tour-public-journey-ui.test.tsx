// @vitest-environment jsdom
/**
 * The public tour page (the prospect journey, `.ps`) draws open days as a row of day cells and times as
 * hairline buttons. The resident portal renders the SAME flow with `embedded`, and keeps its month grid.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockProperty } from "@/data/types";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
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
  tagline: "",
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

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stubOpenSlots() {
  const day = new Date(Date.now() + 3 * 864e5);
  const host = [{ userId: "m1", label: "Manager", propertyId: PROPERTY.id }];
  const slotHosts = { [`${ymd(day)}:20`]: host, [`${ymd(day)}:22`]: host };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ slotHosts }) }) as unknown as Response),
  );
}

async function toDateStep(embedded: boolean) {
  render(<TourScheduleFlow property={PROPERTY} returnAfterAuth="/rent" onSuccess={() => {}} embedded={embedded} />);
  fireEvent.click(await screen.findByText(`${PROPERTY.buildingName} · ${PROPERTY.unitLabel}`));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("public tour scheduler look", () => {
  it("public: open days are square day cells and a picked day lists its times", async () => {
    stubOpenSlots();
    await toDateStep(false);
    await waitFor(() => expect(document.querySelectorAll(".ps-j-day").length).toBe(1));
    fireEvent.click(document.querySelector(".ps-j-day")!);
    expect(document.querySelectorAll(".ps-j-time").length).toBe(2);
    fireEvent.click(document.querySelector(".ps-j-time")!);
    expect(document.querySelector(".ps-j-time[aria-pressed='true']")).toBeTruthy();
  });

  it("embedded (resident portal): keeps the month grid, no journey classes", async () => {
    stubOpenSlots();
    await toDateStep(true);
    await waitFor(() => expect(screen.getAllByLabelText(/open for tours/).length).toBeGreaterThan(0));
    expect(document.querySelector(".ps-j-day")).toBeNull();
    expect(document.querySelector(".ps-j-steps")).toBeNull();
  });
});

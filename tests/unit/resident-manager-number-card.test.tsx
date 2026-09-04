// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  ResidentManagerNumberCard,
  managerContactCaption,
} from "@/components/portal/resident-manager-number-card";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

afterEach(cleanup);

function stubContacts(contacts: unknown[]) {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ contacts }), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

describe("resident manager number card", () => {
  it("shows the number as a tappable sms link", async () => {
    stubContacts([{ phone: "+12065559000", propertyLabel: "4709A", leaseStart: null, leaseEnd: null, status: "current" }]);
    const { container } = render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(screen.getByText("Text your manager")).toBeTruthy());
    // A tel/sms link so a phone opens its messages app pre-addressed rather
    // than making the resident copy digits off the screen.
    const link = container.querySelector('[data-attr="resident-manager-number-link"]');
    expect(link?.getAttribute("href")).toBe("sms:+12065559000");
  });

  it("renders nothing when the manager has no sendable number", async () => {
    // Showing a number that cannot receive a text is worse than showing none.
    stubContacts([]);
    const { container } = render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(container.querySelector('[data-attr="resident-manager-number"]')).toBeNull());
  });

  it("labels each number by property only when there are several", async () => {
    stubContacts([
      { phone: "+12065559000", propertyLabel: "4709A 8th Ave NE", leaseStart: null, leaseEnd: "2026-10-31", status: "current" },
      { phone: "+12065559111", propertyLabel: "5259 Brooklyn Ave NE", leaseStart: "2026-11-01", leaseEnd: null, status: "upcoming" },
    ]);
    render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(screen.getByText(/4709A 8th Ave NE/)).toBeTruthy());
    expect(screen.getByText(/5259 Brooklyn Ave NE/)).toBeTruthy();
  });
});

describe("managerContactCaption", () => {
  const base = { phone: "+1", propertyLabel: null, leaseStart: null, leaseEnd: null } as const;

  it("stays plain for a single tenancy", () => {
    expect(managerContactCaption({ ...base, status: "current" }, false)).toBe("Replies show up here too.");
  });

  it("dates an upcoming home so a mid-move resident can tell them apart", () => {
    expect(managerContactCaption({ ...base, status: "upcoming", leaseStart: "2026-11-01" }, true)).toMatch(/^From /);
  });

  it("dates the home being left", () => {
    expect(managerContactCaption({ ...base, status: "current", leaseEnd: "2026-10-31" }, true)).toMatch(/^Until /);
  });
});

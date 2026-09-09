// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  ResidentManagerNumberCard,
  managerContactCaption,
} from "@/components/portal/resident-manager-number-card";
import { resetResidentManagerContactsCache } from "@/hooks/use-resident-manager-contacts";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

afterEach(() => {
  cleanup();
  // The contact lookup is shared page-wide, so it caches at module level. Each
  // case stubs a different account's reply and must not read the last one's.
  resetResidentManagerContactsCache();
});

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
    // The label shares its line with the caption now that the card is compact,
    // so match the label rather than the whole line.
    await waitFor(() => expect(screen.getByText(/Your property manager/)).toBeTruthy());
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

  it("shows the manager assistant email when provisioned", async () => {
    stubContacts([
      {
        phone: null,
        assistantEmail: "assist-acme@prop-lane.space",
        propertyLabel: "4709A",
        leaseStart: null,
        leaseEnd: null,
        status: "current",
      },
    ]);
    const { container } = render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(screen.getByText("assist-acme@prop-lane.space")).toBeTruthy());
    const link = container.querySelector('[data-attr="resident-manager-email-link"]');
    expect(link?.getAttribute("href")).toBe("mailto:assist-acme@prop-lane.space");
  });

  it("leads with the contact and names the manager beside the role", async () => {
    stubContacts([
      {
        managerName: "Akash Jain",
        phone: "+12065559000",
        propertyLabel: "4709A 8th Ave NE",
        leaseStart: null,
        leaseEnd: null,
        status: "current",
      },
    ]);
    const { container } = render(<ResidentManagerNumberCard />);
    // The reachable CONTACT is the value, mirroring the manager's own card,
    // which leads with their work number rather than their name.
    await waitFor(() => expect(screen.getByText("+1 (206) 555-9000")).toBeTruthy());
    expect(screen.getByText(/Akash Jain · Your property manager/)).toBeTruthy();
    expect(container.querySelector('[data-attr="resident-manager-number-link"]')?.getAttribute("href")).toBe(
      "sms:+12065559000",
    );
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
    expect(managerContactCaption({ ...base, status: "current" }, false)).toBe(
      "Replies in PropLane show up in your conversations below.",
    );
  });

  it("dates an upcoming home so a mid-move resident can tell them apart", () => {
    expect(managerContactCaption({ ...base, status: "upcoming", leaseStart: "2026-11-01" }, true)).toMatch(/^From /);
  });

  it("dates the home being left", () => {
    expect(managerContactCaption({ ...base, status: "current", leaseEnd: "2026-10-31" }, true)).toMatch(/^Until /);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  ResidentManagerNumberCard,
  managerContactCaption,
  phoneActions,
  residentPhoneLabel,
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
    stubContacts([{ phone: "+12065559000", phoneKind: "work", propertyLabel: "4709A", leaseStart: null, leaseEnd: null, status: "current" }]);
    const { container } = render(<ResidentManagerNumberCard />);
    // The label shares its line with the caption now that the card is compact,
    // so match the label rather than the whole line.
    await waitFor(() => expect(screen.getByText(/Your property manager/)).toBeTruthy());
    // A tel/sms link so a phone opens its messages app pre-addressed rather
    // than making the resident copy digits off the screen.
    const link = container.querySelector('[data-attr="resident-manager-number-link"]');
    expect(link?.getAttribute("href")).toBe("sms:+12065559000");
  });

  it("renders nothing only when the manager has neither a phone nor an email", async () => {
    // The server already fell back to the profile; an empty list means there
    // is truly nothing to act on, and a card with nothing to act on is wrong.
    stubContacts([]);
    const { container } = render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(container.querySelector('[data-attr="resident-manager-number"]')).toBeNull());
  });

  it("shows the work email alone when there is no phone", async () => {
    stubContacts([
      {
        phone: null,
        phoneKind: null,
        email: "assist-acme@prop-lane.space",
        emailKind: "work",
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
    expect(container.querySelector('[data-attr="portal-inbox-contact-card-secondary"]')).toBeNull();
  });

  it("shows the phone and the email as two rows, each with its own action", async () => {
    // The email used to survive only as an icon beside the number. Both are
    // things the resident came to read, so both are printed.
    stubContacts([
      {
        managerName: "Test Manager",
        phone: "+15103098345",
        phoneKind: "profile",
        email: "manager@test.proplane.local",
        emailKind: "account",
        propertyLabel: "Proof Oak House",
        leaseStart: null,
        leaseEnd: null,
        status: "current",
      },
    ]);
    const { container } = render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(screen.getByText("(510) 309-8345")).toBeTruthy());
    const secondary = container.querySelector('[data-attr="portal-inbox-contact-card-secondary"]');
    expect(secondary?.textContent).toContain("manager@test.proplane.local");
    expect(secondary?.textContent).toContain("Email");
    expect(container.querySelector('[data-attr="resident-manager-email-link"]')?.getAttribute("href")).toBe(
      "mailto:manager@test.proplane.local",
    );
    // A profile phone is a real line: it rings, so it gets Call as well as Text.
    expect(container.querySelector('[data-attr="resident-manager-call-link"]')?.getAttribute("href")).toBe(
      "tel:+15103098345",
    );
    expect(container.querySelector('[data-attr="resident-manager-number-link"]')?.getAttribute("href")).toBe(
      "sms:+15103098345",
    );
  });

  it("offers Text only for a work number, which never rings", async () => {
    stubContacts([
      { phone: "+12065559000", phoneKind: "work", email: null, emailKind: null, propertyLabel: "4709A", leaseStart: null, leaseEnd: null, status: "current" },
    ]);
    const { container } = render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(container.querySelector('[data-attr="resident-manager-number-link"]')).not.toBeNull());
    expect(container.querySelector('[data-attr="resident-manager-call-link"]')).toBeNull();
  });

  it("leads with the contact and names the manager beside the role", async () => {
    stubContacts([
      {
        managerName: "Akash Jain",
        phone: "+12065559000",
        phoneKind: "work",
        propertyLabel: "4709A 8th Ave NE",
        leaseStart: null,
        leaseEnd: null,
        status: "current",
      },
    ]);
    const { container } = render(<ResidentManagerNumberCard />);
    // The reachable CONTACT is the value, mirroring the manager's own card,
    // which leads with their work number rather than their name.
    // A US number drops its "+1": with two action buttons beside it the full
    // form truncated mid-digit in the list pane.
    await waitFor(() => expect(screen.getByText("(206) 555-9000")).toBeTruthy());
    expect(screen.getByText(/Akash Jain · Your property manager/)).toBeTruthy();
    expect(container.querySelector('[data-attr="resident-manager-number-link"]')?.getAttribute("href")).toBe(
      "sms:+12065559000",
    );
  });

  it("labels each number by property only when there are several", async () => {
    stubContacts([
      { phone: "+12065559000", phoneKind: "work", propertyLabel: "4709A 8th Ave NE", leaseStart: null, leaseEnd: "2026-10-31", status: "current" },
      { phone: "+12065559111", phoneKind: "work", propertyLabel: "5259 Brooklyn Ave NE", leaseStart: "2026-11-01", leaseEnd: null, status: "upcoming" },
    ]);
    render(<ResidentManagerNumberCard />);
    await waitFor(() => expect(screen.getByText(/4709A 8th Ave NE/)).toBeTruthy());
    expect(screen.getByText(/5259 Brooklyn Ave NE/)).toBeTruthy();
  });
});

describe("phoneActions", () => {
  it("gives a profile phone Call and Text, in that order", () => {
    expect(phoneActions({ phone: "+15103098345", phoneKind: "profile" }, "(510) 309-8345").map((a) => a.key)).toEqual([
      "call",
      "text",
    ]);
  });

  it("gives a work number Text only", () => {
    expect(phoneActions({ phone: "+12065559000", phoneKind: "work" }, null).map((a) => a.key)).toEqual(["text"]);
  });

  it("offers nothing without a phone", () => {
    expect(phoneActions({ phone: null, phoneKind: null }, null)).toEqual([]);
  });
});

describe("residentPhoneLabel", () => {
  it("drops the +1 from a North American number and keeps every other form", () => {
    expect(residentPhoneLabel("+15103098345")).toBe("(510) 309-8345");
    expect(residentPhoneLabel("+442071234567")).not.toMatch(/^\(/);
  });
});

describe("managerContactCaption", () => {
  const base = { leaseStart: null, leaseEnd: null } as const;

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

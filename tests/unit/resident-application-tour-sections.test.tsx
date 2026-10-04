// @vitest-environment jsdom
//
// C1-R1 / C1-R2: the resident Application page's Sent | Approved | Denied sections and the Tour
// page's Scheduled | Approved | Past sections (tabs + counts), and the Schedule tour gate in the
// picker: a home that needs an approved application (or whose application was denied) cannot be
// scheduled, and the reason is the button's tooltip/accessible name - no subtext line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ResidentTourView } from "@/lib/tour-resident-link.server";
import {
  countResidentApplicationSections,
  defaultResidentApplicationSection,
  residentApplicationSectionOf,
  residentApplicationStatusWord,
} from "@/lib/resident-application-sections";
import {
  countResidentToursBySection,
  defaultResidentTourSection,
  residentTourSectionForView,
} from "@/lib/resident-tour-list";
import { TOUR_BLOCK_MESSAGES } from "@/lib/application-before-tour-policy";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer?: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MODAL_HEADER_CLOSE_CLASS: "",
}));
vi.mock("@/components/marketing/tour-schedule-flow", () => ({ TourScheduleFlow: () => <div data-testid="tour-schedule-flow" /> }));
vi.mock("@/components/marketing/property-search-picker", () => ({
  PropertySearchPicker: ({ onChange }: { onChange: (id: string) => void }) => (
    <button type="button" data-testid="pick-home" onClick={() => onChange("prop-1")}>
      pick
    </button>
  ),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  isPropertyActiveForLeads: () => true,
  loadPublicExtraListingsFromServer: () => Promise.resolve([]),
  loadPublicPropertyLeadFromServer: () => Promise.resolve(undefined),
  readExtraListingsPublic: () => [],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({ filterSandboxFromPublicCatalog: (list: unknown[]) => list }));
vi.mock("@/lib/public-demo-access", () => ({ isProductionPublicSite: () => false }));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => undefined,
  getPropertyForPublicLink: () => undefined,
}));

import { ResidentTourPanel } from "@/components/portal/resident-tour-panel";
import { ResidentScheduleTourModal } from "@/components/portal/resident-schedule-tour-modal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const app = (bucket: DemoApplicantRow["bucket"], stage = "Submitted"): DemoApplicantRow =>
  ({ id: `APP-${bucket}-${stage}`, name: "J", email: "j@example.com", property: "Maple", propertyId: "p", stage, bucket, detail: "" }) as DemoApplicantRow;

describe("resident application sections", () => {
  it("puts pending (incl. drafts and withdrawn) in Sent, approved in Approved, rejected in Denied", () => {
    expect(residentApplicationSectionOf(app("pending"))).toBe("sent");
    expect(residentApplicationSectionOf(app("pending", "In progress"))).toBe("sent");
    expect(residentApplicationSectionOf(app("approved", "Approved"))).toBe("approved");
    expect(residentApplicationSectionOf(app("rejected", "Declined"))).toBe("denied");
  });

  it("counts every section and opens on the first non-empty one", () => {
    const rows = [app("pending"), app("pending", "In progress"), app("rejected", "Declined")];
    const counts = countResidentApplicationSections(rows);
    expect(counts).toEqual({ sent: 2, approved: 0, denied: 1 });
    expect(defaultResidentApplicationSection(counts)).toBe("sent");
    expect(defaultResidentApplicationSection({ sent: 0, approved: 0, denied: 3 })).toBe("denied");
    expect(defaultResidentApplicationSection({ sent: 0, approved: 0, denied: 0 })).toBe("sent");
  });

  it("reads status as plain words: Incomplete for a draft, Denied, Approved", () => {
    expect(residentApplicationStatusWord(app("pending", "In progress"))).toEqual({ tone: "warn", text: "Incomplete" });
    expect(residentApplicationStatusWord(app("rejected", "Declined"))).toEqual({ tone: "bad", text: "Denied" });
    expect(residentApplicationStatusWord(app("approved", "Approved")).tone).toBe("ok");
  });
});

const NOW = new Date("2026-10-03T12:00:00Z");
const tour = (over: Partial<ResidentTourView>): ResidentTourView => ({
  inquiryId: "inq",
  tourGroupId: null,
  status: "pending",
  propertyId: "prop-1",
  propertyTitle: "Maple House",
  roomLabel: null,
  managerUserId: null,
  managerLabel: null,
  guestName: null,
  guestEmail: null,
  guestPhone: null,
  notes: null,
  instructions: null,
  proposedStart: "2026-10-10T19:00:00.000Z",
  proposedEnd: "2026-10-10T19:30:00.000Z",
  requestedWindows: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  confirmed: false,
  confirmedStart: null,
  confirmedEnd: null,
  ...over,
});

describe("resident tour sections", () => {
  it("Scheduled = requested and ahead, Approved = confirmed and ahead, Past = declined, cancelled or over", () => {
    expect(residentTourSectionForView(tour({}), NOW)).toBe("scheduled");
    expect(
      residentTourSectionForView(tour({ confirmed: true, status: "confirmed", confirmedEnd: "2026-10-10T19:30:00.000Z" }), NOW),
    ).toBe("approved");
    expect(residentTourSectionForView(tour({ status: "declined" }), NOW)).toBe("past");
    expect(residentTourSectionForView(tour({ status: "cancelled" }), NOW)).toBe("past");
    expect(
      residentTourSectionForView(tour({ confirmed: true, status: "confirmed", confirmedEnd: "2026-09-01T19:30:00.000Z" }), NOW),
    ).toBe("past");
  });

  it("counts the sections and opens on the first non-empty one", () => {
    const tours = [tour({ inquiryId: "a" }), tour({ inquiryId: "b", status: "declined" }), tour({ inquiryId: "c", status: "declined" })];
    const counts = countResidentToursBySection(tours, NOW);
    expect(counts).toEqual({ scheduled: 1, approved: 0, past: 2 });
    expect(defaultResidentTourSection({ scheduled: 0, approved: 0, past: 2 })).toBe("past");
  });
});

describe("ResidentTourPanel tabs", () => {
  it("shows Scheduled | Approved | Past with counts, filters the list per tab", async () => {
    const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    const tours = [
      tour({ inquiryId: "s1", propertyTitle: "Alder Row", proposedStart: future(5), proposedEnd: future(5) }),
      tour({ inquiryId: "a1", propertyTitle: "Maple House", confirmed: true, status: "confirmed", confirmedStart: future(6), confirmedEnd: future(6) }),
      tour({ inquiryId: "p1", propertyTitle: "Birch Studio", status: "declined" }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tours }) }));
    render(<ResidentTourPanel basePath="/resident" />);

    const tab = async (id: string) => (await waitFor(() => {
      const el = document.querySelector(`[data-attr="resident-tour-section-${id}"]`) as HTMLElement | null;
      if (!el) throw new Error("no tab");
      return el;
    }));
    const scheduled = await tab("scheduled");
    expect(scheduled.textContent).toContain("Scheduled");
    expect(scheduled.textContent).toContain("1");
    expect((await tab("approved")).textContent).toContain("Approved");
    expect((await tab("past")).textContent).toContain("Past");

    expect(screen.getAllByText(/Alder Row/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Maple House/).length).toBe(0);
    await act(async () => {
      (await tab("approved")).click();
    });
    expect(screen.getAllByText(/Maple House/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Alder Row/).length).toBe(0);
    await act(async () => {
      (await tab("past")).click();
    });
    expect(screen.getAllByText(/Birch Studio/).length).toBeGreaterThan(0);
  });
});

describe("Schedule tour gate in the picker (setting x application)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  const gateBody = (required: boolean, status: "none" | "submitted" | "approved" | "denied") => {
    const reason =
      required && status === "denied" ? "denied" : !required || status === "approved" ? null : status === "submitted" ? "pending_approval" : "apply_first";
    return { required, applicationStatus: status, allowed: reason === null, reason, signedIn: true };
  };

  const cases: Array<[boolean, "none" | "submitted" | "approved" | "denied", keyof typeof TOUR_BLOCK_MESSAGES | null]> = [
    [true, "none", "apply_first"],
    [true, "submitted", "pending_approval"],
    [true, "approved", null],
    [true, "denied", "denied"],
    [false, "none", null],
    [false, "submitted", null],
    [false, "approved", null],
    [false, "denied", null],
  ];

  it.each(cases)("setting required=%s, application %s -> blocked reason %s", async (required, status, reason) => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => gateBody(required, status) } as never);
    render(<ResidentScheduleTourModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("pick-home"));
    const continueButton = () => screen.getByRole("button", { name: /^Continue/ }) as HTMLButtonElement;
    if (reason) {
      await waitFor(() => expect(continueButton().disabled).toBe(true));
      await waitFor(() => expect(continueButton().title).toBe(TOUR_BLOCK_MESSAGES[reason]));
      expect(continueButton().getAttribute("aria-label")).toContain(TOUR_BLOCK_MESSAGES[reason]);
      // The reason is the tooltip only: no visible subtext line is added to the dialog body.
      expect(screen.queryByText(TOUR_BLOCK_MESSAGES[reason])).toBeNull();
    } else {
      await waitFor(() => expect(continueButton().disabled).toBe(false));
      expect(continueButton().title).toBe("");
    }
  });
});

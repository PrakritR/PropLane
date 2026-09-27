// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResidentTourPanel } from "@/components/portal/resident-tour-panel";

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) => (open ? <div role="dialog" aria-label={title}><h2>{title}</h2>{children}</div> : null),
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  // The phone action sheet (vaul) imports the close-button class from here.
  MODAL_HEADER_CLOSE_CLASS: "",
}));
vi.mock("@/components/marketing/tour-schedule-flow", () => ({
  TourScheduleFlow: () => <div data-testid="tour-schedule-flow" />,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  isPropertyActiveForLeads: () => true,
  loadPublicExtraListingsFromServer: () => Promise.resolve([]),
  loadPublicPropertyLeadFromServer: () => Promise.resolve(undefined),
  readExtraListingsPublic: () => [],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({
  filterSandboxFromPublicCatalog: (list: unknown[]) => list,
}));
vi.mock("@/lib/public-demo-access", () => ({
  isProductionPublicSite: () => false,
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => undefined,
  getPropertyForPublicLink: () => undefined,
}));

afterEach(cleanup);

describe("ResidentTourPanel", () => {
  it("renders tour detail tabs on the inquiry detail route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tours: [
            {
              inquiryId: "inq-1",
              tourGroupId: null,
              status: "pending",
              propertyId: "prop-1",
              propertyTitle: "Maple House",
              roomLabel: "Room 2A",
              managerUserId: "mgr-1",
              managerLabel: "Jordan Lee",
              guestName: "Lucas",
              guestEmail: "lucas@example.com",
              guestPhone: "+12065550100",
              notes: "Looking for a quiet room.",
              instructions: null,
              proposedStart: "2026-07-31T19:30:00.000Z",
              proposedEnd: "2026-07-31T20:00:00.000Z",
              requestedWindows: [{ start: "2026-07-31T19:30:00.000Z", end: "2026-07-31T20:00:00.000Z" }],
              createdAt: "2026-07-31T18:00:00.000Z",
              confirmed: false,
              confirmedStart: null,
              confirmedEnd: null,
            },
          ],
        }),
      }),
    );

    render(<ResidentTourPanel basePath="/resident" inquiryId="inq-1" bucket="pending" />);

    expect(await screen.findByText("Tour details")).toBeTruthy();
    expect(screen.queryByText("Tour confirmed")).toBeNull();
    expect(screen.getAllByText("Maple House").length).toBeGreaterThan(0);
    expect(screen.getByText("Lucas")).toBeTruthy();
    expect(screen.getByText("(206) 555-0100")).toBeTruthy();
    expect(screen.getByText("Looking for a quiet room.")).toBeTruthy();
  });

  it("shows schedule tour control when the tour list is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tours: [] }),
      }),
    );

    render(<ResidentTourPanel basePath="/resident" bucket="pending" />);

    expect(await screen.findByRole("button", { name: "Schedule a tour" })).toBeTruthy();
    expect(document.querySelector('[data-attr="resident-tour-schedule"]')).toBeTruthy();
    // C120: one list, no Pending/Confirmed/Declined tabs — with zero tours there
    // is nothing to show a status for, and no tab bar left to read those words from.
    expect(screen.queryByText("Pending")).toBeNull();
    expect(screen.queryByText("Confirmed")).toBeNull();
    expect(screen.queryByText("Your scheduled property tours and requested times.")).toBeNull();
    // Add rows read in sentence case since the portal redesign (plus glyph + label).
    expect(screen.getByText("Schedule tour")).toBeTruthy();
  });

  it("opens schedule tour in a modal instead of leaving the tour tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tours: [] }),
      }),
    );

    render(<ResidentTourPanel basePath="/resident" bucket="declined" />);

    const scheduleButton = await screen.findByRole("button", { name: "Schedule a tour" });
    fireEvent.click(scheduleButton);
    expect(await screen.findByRole("dialog", { name: "Choose a home to tour" })).toBeTruthy();
    expect(screen.getByLabelText("Search homes to tour")).toBeTruthy();
  });

  it("merges every status into one list instead of three tabs (C120)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tours: [
            {
              inquiryId: "inq-pending",
              tourGroupId: null,
              status: "pending",
              propertyId: "prop-1",
              propertyTitle: "Maple House",
              roomLabel: null,
              managerUserId: "mgr-1",
              managerLabel: null,
              guestName: "Lucas",
              guestEmail: "lucas@example.com",
              guestPhone: null,
              notes: null,
              instructions: null,
              proposedStart: "2026-07-31T19:30:00.000Z",
              proposedEnd: "2026-07-31T20:00:00.000Z",
              requestedWindows: [],
              createdAt: "2026-07-31T18:00:00.000Z",
              confirmed: false,
              confirmedStart: null,
              confirmedEnd: null,
            },
            {
              inquiryId: "inq-confirmed",
              tourGroupId: null,
              status: "confirmed",
              propertyId: "prop-2",
              propertyTitle: "Alder Row",
              roomLabel: null,
              managerUserId: "mgr-1",
              managerLabel: null,
              guestName: "Lucas",
              guestEmail: "lucas@example.com",
              guestPhone: null,
              notes: null,
              instructions: null,
              proposedStart: "2026-08-02T19:30:00.000Z",
              proposedEnd: "2026-08-02T20:00:00.000Z",
              requestedWindows: [],
              createdAt: "2026-08-01T18:00:00.000Z",
              confirmed: true,
              confirmedStart: "2026-08-02T19:30:00.000Z",
              confirmedEnd: "2026-08-02T20:00:00.000Z",
            },
            {
              inquiryId: "inq-declined",
              tourGroupId: null,
              status: "declined",
              propertyId: "prop-3",
              propertyTitle: "Birch Studio",
              roomLabel: null,
              managerUserId: "mgr-1",
              managerLabel: null,
              guestName: "Lucas",
              guestEmail: "lucas@example.com",
              guestPhone: null,
              notes: null,
              instructions: null,
              proposedStart: "2026-07-01T19:30:00.000Z",
              proposedEnd: "2026-07-01T20:00:00.000Z",
              requestedWindows: [],
              createdAt: "2026-06-30T18:00:00.000Z",
              confirmed: false,
              confirmedStart: null,
              confirmedEnd: null,
            },
          ],
        }),
      }),
    );

    render(<ResidentTourPanel basePath="/resident" bucket="pending" />);

    // All three, regardless of status, in the one list — not filtered by tab.
    expect((await screen.findAllByText("Maple House")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alder Row").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Birch Studio").length).toBeGreaterThan(0);
    // Status reads as text on the row, not as a tab.
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.getByText("Declined")).toBeTruthy();
    // No tab-bar destinations left to pick a bucket from.
    expect(document.querySelector('[data-attr="resident-tour-bucket-pending"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-bucket-confirmed"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-tour-bucket-declined"]')).toBeNull();
  });

  it("shows confirmed banner on approved tour detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tours: [
            {
              inquiryId: "inq-2",
              tourGroupId: null,
              status: "confirmed",
              propertyId: "prop-2",
              propertyTitle: "Alder Row",
              roomLabel: "Room 1",
              managerUserId: "mgr-1",
              managerLabel: "Jordan Lee",
              guestName: "Lucas",
              guestEmail: "lucas@example.com",
              guestPhone: null,
              notes: null,
              instructions: "Ring the side door.",
              proposedStart: "2026-08-02T19:30:00.000Z",
              proposedEnd: "2026-08-02T20:00:00.000Z",
              requestedWindows: [{ start: "2026-08-02T19:30:00.000Z", end: "2026-08-02T20:00:00.000Z" }],
              createdAt: "2026-08-01T18:00:00.000Z",
              confirmed: true,
              confirmedStart: "2026-08-02T19:30:00.000Z",
              confirmedEnd: "2026-08-02T20:00:00.000Z",
            },
          ],
        }),
      }),
    );

    render(<ResidentTourPanel basePath="/resident" inquiryId="inq-2" bucket="confirmed" />);

    expect(await screen.findByText("Tour confirmed")).toBeTruthy();
    expect(screen.getAllByText(/Alder Row/).length).toBeGreaterThan(0);
  });
});

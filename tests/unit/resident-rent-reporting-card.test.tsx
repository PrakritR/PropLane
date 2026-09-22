// @vitest-environment jsdom
//
// The "Report my rent to credit bureaus" card on the resident Payments page:
// off shows a toggle, turning it on opens the consent sheet, agreeing sends
// legal name + DOB to the server, and a manager on Free shows an Upgrade lock
// instead of a working toggle.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/payments/pending",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: "resident@example.com", userId: "res-1", displayName: "Resident" }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-native-platform", () => ({ useNativePlatform: () => null }));
// The resident 7-day visibility window (`household-charge-visibility.ts`)
// compares this charge's due date against the real wall clock at render
// time, so the label is computed relative to "now" rather than pinned to a
// literal calendar date that would eventually fall outside the window.
function daysFromNowLabel(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  const charges = [
    {
      createdAt: "2026-09-01T00:00:00.000Z",
      residentEmail: "resident@example.com",
      residentName: "Resident",
      residentUserId: "res-1",
      propertyId: "prop-1",
      propertyLabel: "123 Main St",
      managerUserId: "mgr-1",
      id: "rent-oct",
      kind: "rent",
      title: "October rent",
      amountLabel: "$1,200.00",
      balanceLabel: "$1,200.00",
      status: "pending",
      blocksLeaseUntilPaid: false,
      axisPaymentsEnabledSnapshot: true,
      managerStripeConnectReadySnapshot: true,
      dueDateLabel: daysFromNowLabel(3),
    },
  ];
  return { ...actual, syncHouseholdChargesFromServer: () => Promise.resolve(), readChargesForResident: () => charges };
});
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  const rows = [
    { id: "AXIS-1", name: "Resident", email: "resident@example.com", property: "123 Main St", stage: "Current resident", bucket: "approved", managerUserId: "mgr-1", detail: "" },
  ];
  return { ...actual, syncManagerApplicationsFromServer: () => Promise.resolve(rows), readManagerApplicationRows: () => rows };
});
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual, syncLeasePipelineFromServer: () => Promise.resolve([]), readLeasePipeline: () => [], findLeaseForResidentEmail: () => null };
});
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return { ...actual, syncPropertyPipelineFromServer: () => Promise.resolve(undefined) };
});
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => null }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: () => <div data-testid="stripe-checkout" />,
}));

type RentReportingState = {
  eligible: boolean;
  addonAvailable: boolean;
  upgradeRequired: boolean;
  status: "active" | "paused" | "stopped";
  reportedAs: string | null;
  lastSubmission: { period: string; status: string; sentAt: string | null } | null;
  bureaus: string;
};

let rentReportingState: RentReportingState = {
  eligible: true,
  addonAvailable: true,
  upgradeRequired: false,
  status: "stopped",
  reportedAs: null,
  lastSubmission: null,
  bureaus: "Experian · TransUnion · Equifax",
};
const putBodies: Array<Record<string, unknown>> = [];

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/resident/rent-reporting")) {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      putBodies.push(body);
      if (body.action === "start") {
        rentReportingState = {
          ...rentReportingState,
          status: "active",
          reportedAs: `${String(body.legalName)} · 123 Main St`,
        };
      } else if (body.action === "stop") {
        rentReportingState = { ...rentReportingState, status: "stopped", reportedAs: null };
      }
      return new Response(JSON.stringify({ status: rentReportingState.status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(rentReportingState), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("/api/reports/resident-ledger")) {
    return new Response(JSON.stringify({ id: "resident-ledger", title: "Resident ledger", columns: [], rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ rows: [], uploads: [], methods: [] }), { status: 200, headers: { "content-type": "application/json" } });
});

import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { resetResidentLedgerCache } from "@/lib/resident-ledger-client";

afterEach(() => {
  cleanup();
  resetResidentLedgerCache();
  putBodies.length = 0;
});

function pickListboxOption(label: string) {
  const listbox = screen.getByRole("listbox");
  const target = within(listbox).getByText(label);
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("resident rent reporting card", () => {
  it("off shows a toggle; turning it on opens the consent sheet and agreeing starts reporting", async () => {
    rentReportingState = {
      eligible: true,
      addonAvailable: true,
      upgradeRequired: false,
      status: "stopped",
      reportedAs: null,
      lastSubmission: null,
      bureaus: "Experian · TransUnion · Equifax",
    };
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByText("Report my rent to credit bureaus")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Report my rent to credit bureaus" }));
    pickListboxOption("On");

    await waitFor(() => expect(screen.getByText("Turn on rent reporting")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Legal name on your credit file"), { target: { value: "Jamie Rivera" } });
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-05-01" } });
    fireEvent.click(screen.getByRole("button", { name: "I agree, turn it on" }));

    await waitFor(() => expect(putBodies.some((b) => b.action === "start")).toBe(true));
    const startBody = putBodies.find((b) => b.action === "start")!;
    expect(startBody).toMatchObject({ action: "start", legalName: "Jamie Rivera", dob: "1990-05-01", consent: true });

    await waitFor(() => expect(screen.getByText(/Jamie Rivera/)).toBeTruthy());
    expect(screen.getByText("Bureaus")).toBeTruthy();
    expect(screen.getByText("Experian · TransUnion · Equifax")).toBeTruthy();
  });

  it("a manager on Free shows an Upgrade lock instead of a working toggle", async () => {
    rentReportingState = {
      eligible: true,
      addonAvailable: false,
      upgradeRequired: true,
      status: "stopped",
      reportedAs: null,
      lastSubmission: null,
      bureaus: "Experian · TransUnion · Equifax",
    };
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByText("Report my rent to credit bureaus")).toBeTruthy());

    expect(screen.getByRole("link", { name: "Upgrade" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report my rent to credit bureaus" })).toBeNull();
  });

  it("no active tenancy hides the card entirely", async () => {
    rentReportingState = {
      eligible: false,
      addonAvailable: false,
      upgradeRequired: false,
      status: "stopped",
      reportedAs: null,
      lastSubmission: null,
      bureaus: "Experian · TransUnion · Equifax",
    };
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByText("October rent")).toBeTruthy());
    expect(screen.queryByText("Report my rent to credit bureaus")).toBeNull();
  });
});

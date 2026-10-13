// @vitest-environment jsdom
//
// EVIDENCE HARNESS (portal sweep round 4 — resident portal).
//
// Renders the resident text thread and the resident Payments page and captures each as a full
// HTML page under EVIDENCE_DIR (set by the evidence run). The assertions are the round's rules:
// bubbles say "You" / "Property manager", the nav badge equals the number of rows the Due tab
// lists, and opening Payments writes nothing to the charge ledger.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HouseholdCharge } from "@/lib/household-charges";

const EMAIL = "maya@example.com";
const USER_ID = "res-maya";

function dueLabel(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const CHARGES: HouseholdCharge[] = [
  {
    id: "rent-oct", kind: "rent", title: "Rent — October 2026", amountLabel: "$1,205.00", balanceLabel: "$1,205.00",
    createdAt: "2026-09-01T00:00:00.000Z", residentEmail: EMAIL, residentName: "Maya Chen", residentUserId: USER_ID,
    propertyId: "prop-8th", propertyLabel: "4709A 8th Ave NE", managerUserId: "mgr-1", status: "pending",
    blocksLeaseUntilPaid: false, axisPaymentsEnabledSnapshot: true, managerStripeConnectReadySnapshot: true,
    dueDateLabel: dueLabel(-2),
  },
  {
    id: "utilities-oct", kind: "utilities", title: "Utilities — October", amountLabel: "$84.50", balanceLabel: "$84.50",
    createdAt: "2026-09-01T00:00:00.000Z", residentEmail: EMAIL, residentName: "Maya Chen", residentUserId: USER_ID,
    propertyId: "prop-8th", propertyLabel: "4709A 8th Ave NE", managerUserId: "mgr-1", status: "pending",
    blocksLeaseUntilPaid: false, axisPaymentsEnabledSnapshot: true, managerStripeConnectReadySnapshot: true,
    dueDateLabel: dueLabel(3),
  },
];

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/payments/overdue",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: EMAIL, userId: USER_ID, displayName: "Maya Chen" }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-native-platform", () => ({ useNativePlatform: () => null }));
vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return { ...actual, syncHouseholdChargesFromServer: () => Promise.resolve(), readChargesForResident: () => CHARGES };
});
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return { ...actual, syncManagerApplicationsFromServer: () => Promise.resolve([]), readManagerApplicationRows: () => [] };
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
vi.mock("@/components/stripe-embedded-checkout", () => ({ StripeEmbeddedCheckout: () => <div /> }));

const TEXTS = {
  smsConfigured: true,
  messages: [
    { id: "m1", direction: "inbound", body: "Hi Maya — the plumber is booked for Thursday at 10am. Does that still work?",
      fromPhone: "+12065550142", toPhone: "+12065550199", messageSid: "SM1", source: "work_number", createdAt: "2026-10-09T17:02:00.000Z" },
    { id: "m2", direction: "outbound", body: "Thursday 10am works, thank you!",
      fromPhone: "+12065550199", toPhone: "+12065550142", messageSid: "SM2", source: "work_number", createdAt: "2026-10-09T17:05:00.000Z" },
  ],
};

const calls: string[] = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url.includes("/sms")) return new Response(JSON.stringify(TEXTS), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("/api/reports/resident-ledger"))
    return new Response(JSON.stringify({ id: "resident-ledger", title: "Resident ledger", columns: [], rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ rows: [], uploads: [], methods: [] }), { status: 200, headers: { "content-type": "application/json" } });
});

import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { RoleSmsPanel } from "@/components/portal/role-sms-panel";
import { residentDueRowCount } from "@/lib/resident-payments-due-count";
import { residentPaymentsNavBadge } from "@/lib/resident-payments-tabs";
import { resetResidentLedgerCache } from "@/lib/resident-ledger-client";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
const capture = (name: string) => captured.push({ name, html: document.body.innerHTML });

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) {
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.html`),
      `<!doctype html>
<html lang="en" data-theme="light" class="h-full antialiased">
<head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground"><div class="portal-shell bg-background"><div class="px-8 py-8">${html}</div></div></body>
</html>`,
      "utf8",
    );
  }
});

afterEach(() => {
  cleanup();
  resetResidentLedgerCache();
  calls.length = 0;
});

describe("round 4 — the resident portal", () => {
  it("a text thread names the sides: You and the property manager", async () => {
    await act(async () => {
      render(<RoleSmsPanel apiPath="/api/resident/sms" storageScope="resident-demo" tabId="all" counterpartName="Property manager" />);
    });
    await screen.findByText("Thursday 10am works, thank you!");
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Property manager")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/inbound|outbound/i);
    capture("r4-resident-text-thread");
  });

  it("Payments lists the Due rows and asks the server for nothing it may not write", async () => {
    await act(async () => {
      render(<ResidentPaymentsPanel bucket="overdue" />);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay all" })).toBeTruthy());
    // The badge the nav draws is exactly the number of rows this tab lists.
    expect(residentPaymentsNavBadge(residentDueRowCount(CHARGES)).count).toBe(1);
    expect(calls.filter((url) => url.includes("portal-household-charges"))).toEqual([]);
    capture("r4-resident-payments-due");
  });
});

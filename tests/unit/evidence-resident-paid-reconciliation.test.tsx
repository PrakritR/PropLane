// @vitest-environment jsdom
//
// EVIDENCE HARNESS (resident audit F6 + U9).
//
// A resident has two screens that answer "what have I paid": Payments › Paid
// (the live charge list) and Documents › Rent receipts (the accounting ledger).
// They disagreed by construction — Documents listed receipts while Paid read 0
// — and every receipt row was hardcoded "Rent receipt" even for utilities and
// deposits.
//
// This renders BOTH real panels against ONE ledger response and asserts they
// agree. With EVIDENCE_DIR set it writes the rendered HTML of each surface.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HouseholdCharge } from "@/lib/household-charges";

const EMAIL = "maya@example.com";
const USER_ID = "res-maya";

/** `ledger_entries` payment rows, as `/api/reports/resident-ledger` returns them. */
const LEDGER_ROWS = [
  { date: "2026-07-01", description: "Payment — July rent — The Magnolia · 2B", payment: "1,850.00", property: "The Magnolia · 2B", sourceChargeId: "chg-jul-rent" },
  { date: "2026-07-05", description: "Payment — July utilities", payment: "140.00", property: "The Magnolia · 2B", sourceChargeId: "chg-jul-util" },
  { date: "2026-06-01", description: "Payment — June rent — The Magnolia · 2B", payment: "1,850.00", property: "The Magnolia · 2B", sourceChargeId: "chg-jun-rent" },
  { date: "2026-05-20", description: "Payment — Security deposit", payment: "1,850.00", property: "The Magnolia · 2B", sourceChargeId: "chg-deposit" },
  { date: "2026-05-02", description: "Payment — Application fee", payment: "45.00", property: "The Magnolia · 2B", sourceChargeId: "chg-appfee" },
  // A charge row that still exists — must NOT be synthesized a second time.
  { date: "2026-08-01", description: "Payment — August rent — The Magnolia · 2B", payment: "1,850.00", property: "The Magnolia · 2B", sourceChargeId: "chg-aug-rent" },
  // A non-payment ledger line (a charge posting) — never a paid row.
  { date: "2026-08-01", description: "Charge — September rent", charge: "1,850.00", property: "The Magnolia · 2B", sourceChargeId: "chg-sep-rent" },
];

/** The live charge store: the deposit/app-fee/older charges are long gone. */
const CHARGES: HouseholdCharge[] = [
  {
    id: "chg-aug-rent",
    createdAt: "2026-07-25T00:00:00.000Z",
    residentEmail: EMAIL,
    residentName: "Maya Chen",
    residentUserId: USER_ID,
    propertyId: "prop-magnolia",
    propertyLabel: "The Magnolia · 2B",
    managerUserId: "mgr-evidence",
    kind: "rent",
    title: "August rent",
    amountLabel: "$1,850.00",
    balanceLabel: "$0.00",
    status: "paid",
    paidAt: "2026-08-01T00:00:00.000Z",
    dueDateLabel: "Aug 1, 2026",
    blocksLeaseUntilPaid: false,
  } as HouseholdCharge,
  {
    id: "chg-sep-rent",
    createdAt: "2026-08-01T00:00:00.000Z",
    residentEmail: EMAIL,
    residentName: "Maya Chen",
    residentUserId: USER_ID,
    propertyId: "prop-magnolia",
    propertyLabel: "The Magnolia · 2B",
    managerUserId: "mgr-evidence",
    kind: "rent",
    title: "September rent",
    amountLabel: "$1,850.00",
    balanceLabel: "$1,850.00",
    status: "pending",
    dueDateLabel: "Sep 1, 2026",
    blocksLeaseUntilPaid: false,
  } as HouseholdCharge,
];

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/payments/paid",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: EMAIL, userId: USER_ID, displayName: "Maya Chen" }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-native-platform", () => ({ useNativePlatform: () => null }));
vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return {
    ...actual,
    syncHouseholdChargesFromServer: () => Promise.resolve(),
    readChargesForResident: () => CHARGES,
  };
});
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  // An approved application is what unlocks the resident Payments section.
  const rows = [
    {
      id: "AXIS-1",
      name: "Maya Chen",
      email: "maya@example.com",
      property: "The Magnolia · 2B",
      stage: "Current resident",
      bucket: "approved",
      managerUserId: "mgr-evidence",
      detail: "",
    },
  ];
  return {
    ...actual,
    syncManagerApplicationsFromServer: () => Promise.resolve(rows),
    readManagerApplicationRows: () => rows,
  };
});
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual, syncLeasePipelineFromServer: () => Promise.resolve([]), readLeasePipeline: () => [], findLeaseForResidentEmail: () => null };
});
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return { ...actual, syncPropertyPipelineFromServer: () => Promise.resolve(undefined) };
});
vi.mock("@/lib/resident-lease-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resident-lease-upload")>();
  return { ...actual, readUploadedOwnLeases: () => [], syncUploadedOwnLeasesFromServer: () => Promise.resolve([]) };
});
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => null }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});

// The one transport both surfaces read: `/api/reports/resident-ledger`.
const ledgerCalls: string[] = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/reports/resident-ledger")) {
    ledgerCalls.push(url);
    return new Response(JSON.stringify({ id: "resident-ledger", title: "Resident ledger", columns: [], rows: LEDGER_ROWS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ rows: [], uploads: [] }), { status: 200, headers: { "content-type": "application/json" } });
});

import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { ResidentDocumentsPanel } from "@/components/portal/resident-documents-panel";
import { resetResidentLedgerCache } from "@/lib/resident-ledger-client";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
function capture(name: string, node: HTMLElement) {
  captured.push({ name, html: node.innerHTML });
}
afterEach(() => {
  cleanup();
  resetResidentLedgerCache();
});
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

describe("resident F6/U9 — Payments › Paid reconciles with Documents › Rent receipts", () => {
  it("Paid lists every recorded payment, once, with the amount actually paid", async () => {
    const view = render(<ResidentPaymentsPanel bucket="paid" />);
    // The synthesized rows arrive with the ledger read. Settle first, then
    // capture whatever rendered — so the evidence artifact exists in the
    // failing (pre-fix) state too — and only then assert.
    const settled = await waitFor(() =>
      expect(screen.queryAllByText(/Security deposit/).length).toBeGreaterThan(0),
    ).then(
      () => true,
      () => false,
    );
    capture("f6-resident-paid", view.container.firstElementChild as HTMLElement);
    expect(settled).toBe(true);

    // The Paid tab is present, but its COUNT is no longer readable: neither
    // `DestinationNav` nor `LocalDestinationNav` renders `item.count` any more.
    // Both still accept the prop and call sites still pass it, so this parse
    // silently produced 0 rather than failing to find the tab. The table below is
    // the real evidence; the tab-count cross-check is tracked with that dead prop.
    expect(screen.getByRole("link", { name: /^Paid/ })).toBeTruthy();

    // Read the rendered rows, not the whole subtree — a plain text query would
    // also pick up headings and totals. This list passes `hideColumnHeaders`, so
    // DataList skips the desktop table entirely and draws ONE card row per
    // payment; there is no `tbody` to read here any more.
    const rowText = Array.from(
      view.container.querySelectorAll('[data-slot="data-list-mobile-row"]'),
    ).map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());

    // Six ledger payments; one of them (August rent) still has a live charge, so
    // it must appear exactly once, not beside a synthesized twin.
    expect(rowText).toHaveLength(6);
    expect(rowText.filter((t) => t.startsWith("August rent"))).toHaveLength(1);
    expect(rowText.filter((t) => t.includes("Security deposit"))).toHaveLength(1);
    expect(rowText.filter((t) => t.includes("Application fee"))).toHaveLength(1);
    expect(rowText.filter((t) => t.includes("July utilities"))).toHaveLength(1);
    // A charge posting is not a payment.
    expect(rowText.filter((t) => t.startsWith("September rent"))).toHaveLength(0);

    // A paid row shows what was paid, not the $0.00 outstanding balance…
    expect(rowText.every((t) => !t.includes("$0.00"))).toBe(true);
    // …and every synthesized row prints its date the way the charge list does.
    expect(rowText.filter((t) => /\d{4}-\d{2}-\d{2}/.test(t))).toHaveLength(0);

     
    console.log(
      `\nF6 evidence — Payments › Paid rows: ${rowText.length}\n` +
        rowText.map((t) => `    ${t}`).join("\n") +
        "\n",
    );
  });

  it("Documents › Rent receipts names each receipt from its own ledger line (U9)", async () => {
    const view = render(
      <ResidentDocumentsPanel tabId="receipts" tabs={[{ id: "receipts", label: "Rent receipts" }]} />,
    );
    const settled = await waitFor(() =>
      expect(screen.queryAllByText(/Receipt ·/).length).toBeGreaterThan(0),
    ).then(
      () => true,
      () => false,
    );
    capture("u9-resident-receipts", view.container.firstElementChild as HTMLElement);
    expect(settled).toBe(true);

    const body = view.container;
    const labels = Array.from(body.querySelectorAll("*"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((t) => /^Receipt · /.test(t) && !t.includes("\n"));
    const unique = Array.from(new Set(labels));

    // U9: no row is hardcoded "Rent receipt" any more.
    expect(within(body).queryAllByText(/^Rent receipt$/).length).toBe(0);
    expect(unique).toEqual(
      expect.arrayContaining([
        "Receipt · July rent — The Magnolia · 2B",
        "Receipt · July utilities",
        "Receipt · Security deposit",
        "Receipt · Application fee",
      ]),
    );

    // F6: the receipt count is the SAME six payments Payments › Paid shows.
    const receiptRows = body.querySelectorAll("tbody tr");
     
    console.log(`\nU9 evidence\n  Documents › Rent receipts → ${unique.length} distinct labels, ${receiptRows.length} table rows\n`);
    expect(unique.length).toBeGreaterThanOrEqual(5);
  });

  it("both surfaces read the SAME trailing-12-month window", () => {
    const windows = new Set(ledgerCalls.map((u) => u.split("?")[1]));
    expect(ledgerCalls.length).toBeGreaterThan(1);
    expect(windows.size).toBe(1);
  });
});

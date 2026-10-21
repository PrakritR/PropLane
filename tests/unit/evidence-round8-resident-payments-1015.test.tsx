// @vitest-environment jsdom
/**
 * Evidence harness for the round-8 resident Payments landing (2026-10-15).
 *
 * Renders the REAL `ResidentPaymentsPanel` and dumps each surface's markup when
 * `EVIDENCE_DIR` is set, the same convention as `evidence-second-pass-1009.test.tsx`
 * (`tests/browser/round8-land-1015.config.ts` paints them with the real Tailwind build):
 *
 *   1. The Charges list — a charge whose stored `dueDateLabel` is an ISO date
 *      ("2026-10-07", "by 2026-10-20") reads as "Due Oct 7, 2026" / "Due by Oct 20, 2026",
 *      and a raw stored amount ("1205", "$450.5") reads as "$1,205.00" / "$450.50"
 *      (`humanizeChargeDate` / `formatChargeMoneyLabel`).
 *   2. `?pay=<chargeId>` — the link now opens THAT charge's record instead of the pay
 *      dialog; the shot is the record the panel navigates to.
 *
 * Mock harness copied from `resident-payments-dashboard-shortcut.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HouseholdCharge } from "@/lib/household-charges";

const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1100px;margin:16px auto;padding:0 16px">
<p style="position:relative;z-index:2147483647;font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;max-width:1040px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

const EMAIL = "maya@example.com";
const USER_ID = "res-maya";

const base = {
  createdAt: "2026-09-01T00:00:00.000Z",
  residentEmail: EMAIL,
  residentName: "Maya Chen",
  residentUserId: USER_ID,
  propertyId: "prop-8th",
  propertyLabel: "4709A 8th Ave NE",
  managerUserId: "mgr-1",
  status: "pending" as const,
  blocksLeaseUntilPaid: false,
  axisPaymentsEnabledSnapshot: true,
  managerStripeConnectReadySnapshot: true,
};

/** Stored labels exactly as the ledger writes them: ISO dates and unpadded amounts. */
const CHARGES: HouseholdCharge[] = [
  {
    ...base,
    id: "rent-oct",
    kind: "rent",
    title: "Rent — October 2026",
    amountLabel: "1205",
    balanceLabel: "1205",
    dueDateLabel: "2026-10-07",
  } as HouseholdCharge,
  {
    ...base,
    id: "utilities-oct",
    kind: "utilities",
    title: "Utilities — October 2026",
    amountLabel: "1205",
    balanceLabel: "1205",
    dueDateLabel: "2026-10-28",
  } as HouseholdCharge,
  {
    ...base,
    id: "proration-oct",
    kind: "other",
    title: "Move-in proration",
    amountLabel: "$450.5",
    balanceLabel: "$450.5",
    dueDateLabel: "by 2026-10-20",
  } as HouseholdCharge,
];

const replaced: string[] = [];
const navigated: string[] = [];
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/payments",
  useRouter: () => ({ push: () => {}, replace: (href: string) => replaced.push(href), refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: EMAIL, userId: USER_ID, displayName: "Maya Chen" }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => (href: string) => { navigated.push(href); } }));
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
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: () => <div data-testid="stripe-checkout" />,
}));

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/reports/resident-ledger")) {
    return new Response(JSON.stringify({ id: "resident-ledger", title: "Resident ledger", columns: [], rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ rows: [], uploads: [], methods: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { resetResidentLedgerCache } from "@/lib/resident-ledger-client";

/**
 * Which tab a charge sits in is read against today, so the clock is pinned to the
 * round-8 landing date: the Oct 20 charge is still Upcoming, the Oct 7 one is Due.
 * Only `Date` is faked so `waitFor` keeps running on real timers.
 */
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T19:00:00.000Z")); // noon Pacific
});
afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  resetResidentLedgerCache();
  replaced.length = 0;
  navigated.length = 0;
  searchParams = new URLSearchParams();
});

describe("evidence · resident Payments reads a stored ISO date and a raw amount as the product's own words", () => {
  it("Upcoming says Due Oct 28, 2026 / Due by Oct 20, 2026 and $1,205.00 / $450.50", async () => {
    const view = render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(view.container.textContent).toContain("Utilities — October 2026"));
    const text = () => view.container.textContent ?? "";
    await waitFor(() => expect(text()).toContain("Due Oct 28, 2026"));
    expect(text()).toContain("Due by Oct 20, 2026");
    expect(text()).toContain("$1,205.00");
    expect(text()).toContain("$450.50");
    // The stored strings themselves never reach the screen.
    expect(text()).not.toContain("2026-10-28");
    expect(text()).not.toMatch(/\$450\.5(?!0)/);

    writeShot(
      "01-resident-payments-due-labels",
      "Resident → Payments → Upcoming. Both charges are stored with an ISO due date (&quot;2026-10-28&quot;, &quot;by 2026-10-20&quot;) and an unpadded amount (&quot;1205&quot;, &quot;$450.5&quot;). The list reads them as the product&#39;s own words — &quot;Due Oct 28, 2026&quot;, &quot;Due by Oct 20, 2026&quot;, &quot;$1,205.00&quot;, &quot;$450.50&quot; — with no raw stored value anywhere on screen.",
      view.container.innerHTML,
    );
  });

  it("the Due tab reads the overdue charge's ISO date as a Pacific wall date", async () => {
    const view = render(<ResidentPaymentsPanel bucket="overdue" />);
    await waitFor(() => expect(view.container.textContent).toContain("Rent — October 2026"));
    await waitFor(() => expect(view.container.textContent).toContain("Due Oct 7, 2026"));
    // Read straight off the string, never through `Date` — never the day before.
    expect(view.container.textContent).not.toContain("Oct 6, 2026");

    writeShot(
      "02-resident-payments-due-tab",
      "Resident → Payments → Due. The October rent is stored as the bare ISO date &quot;2026-10-07&quot;; it reads &quot;Due Oct 7, 2026&quot; — the calendar date off the string, not a UTC midnight shifted back a day west of Greenwich.",
      view.container.innerHTML,
    );
  });

  it("?pay=<chargeId> opens that charge's record and starts no payment", async () => {
    searchParams = new URLSearchParams("pay=proration-oct");
    const list = render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(navigated.some((href) => href.includes("proration-oct"))).toBe(true));
    // Round 8: Opening never starts a payment — no pay dialog, and the destination is the record route.
    expect(screen.queryByRole("dialog")).toBeNull();
    const href = navigated.find((candidate) => candidate.includes("proration-oct"))!;
    expect(href).toMatch(/\/resident\/payments\/(pending|overdue)\/proration-oct/);
    list.unmount();

    // That destination, rendered: the charge record the deep link lands on, with Pay on the record.
    const record = render(<ResidentPaymentsPanel bucket="pending" chargeId="proration-oct" />);
    await waitFor(() => expect(record.container.textContent).toContain("Move-in proration"));
    await waitFor(() => expect(record.container.textContent).toContain("By Oct 20, 2026"));
    expect(record.container.textContent).toContain("$450.50");

    writeShot(
      "03-resident-payments-pay-param-record",
      `Resident → a "?pay=proration-oct" link (the dashboard attention row). Round 8: the link no longer pops the pay dialog open over the list — it deep-links to that exact charge's record, ${href}, shown here. The resident reads the charge first and pays from the record. "?pay=now" still opens the pay sheet for everything owed.`,
      record.container.innerHTML,
    );
  });
});

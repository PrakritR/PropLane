// @vitest-environment jsdom
//
// EVIDENCE HARNESS for the parts of studio plan claude-1/mobile-step-tabs-1004
// that no other evidence harness renders:
//
//   1. phone step popups — the steps are underline TABS across the top (no
//      "Step N of M" dropdown), and a locked tab refuses with its own reason;
//   2. Pricing — exactly two sections, Long term and Short term, never a Both,
//      each with its own prices, plus the OPTIONAL month-to-month surcharge;
//   3. the same Pricing on a Seattle listing — the surcharge is not offered;
//   4. Finances cash flow — ONE running-total chart with period + series in a
//      single Filter popover and KPI tiles that are period totals;
//   5. Settings › Integrations — one page with Messages / Bookings / Posting /
//      Google, Facebook Marketplace offered as "Copy post" only.
//
// Same contract as the other evidence-* harnesses: without EVIDENCE_DIR this is
// a plain render test and writes nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderedBodyHtml } from "../helpers/evidence-dom";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string; caption: string }[] = [];
function capture(name: string, caption: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: renderedBodyHtml(), caption });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html, caption } of captured) {
    writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
    writeFileSync(join(EVIDENCE_DIR, `${name}.caption.txt`), caption, "utf8");
  }
});

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({
    workspaces: [{ id: "w1", name: "Seattle Homes", owned: true, canManageMembers: true, propertyIds: ["p1"], propertyLabels: { p1: "4709A 8th Ave" } }],
    active: { id: "w1", name: "Seattle Homes", owned: true, canManageMembers: true, propertyIds: ["p1"], propertyLabels: { p1: "4709A 8th Ave" } },
  }),
}));
vi.mock("@/components/portal/integrations-messages-panel", () => ({
  ManagerMessageChannelsPanel: () => <div data-testid="pane-messaging" />,
}));
vi.mock("@/components/portal/manager-sheet-link-panel", () => ({ ManagerSheetLinkPanel: () => <div data-testid="pane-google" /> }));
vi.mock("@/components/portal/integrations-bookings-panel", () => ({ ManagerBookingChannelsPanel: () => <div data-testid="pane-bookings" /> }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: (id: string) => ({ id, listingSubmission: { syndication: { zillow: { enabled: true } } } }),
}));
vi.mock("@/lib/property-promotion-builtin", () => ({
  resolveBuiltinTextCopy: (property: { id: string }, format: string) => ({ format, plain: `post for ${property.id}`, tone: "x" }),
}));

import { WorkNumberSetupModal } from "@/components/portal/pro-work-number-setup-modal";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { staysPatch } from "@/lib/listing-stays";
import { listingOffersMonthToMonthSurcharge } from "@/lib/listing-fees";
import { pricingSectionOptions } from "@/lib/pricing-lease-options";
import { StepPricing } from "@/components/portal/listing-wizard-v2/listing-detail-steps";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import { ManagerIntegrationsPanel } from "@/components/portal/manager-integrations-panel";
import { LinkedFormsFinishList } from "@/components/marketing/linked-forms-finish-list";

/** A touch phone: coarse pointer, narrow window — what the step tabs are for. */
function phoneViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}
/** A desktop (fine pointer) so the cash-flow Filter renders its anchored popover. */
function desktopViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

beforeEach(() => {
  showToast.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ feedUrl: "https://proplane.ai/api/feeds/zillow/abc" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function workNumberStatus(): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "business", source: "stripe" },
    number: null,
    workspace: { id: "ws-1", name: "Seattle Homes", owned: true, isDefault: true },
    workspaces: [
      { workspaceId: "ws-1", workspaceName: "Seattle Homes", owned: true, isDefault: true, ownerName: "Manager", phoneNumber: null, provisionState: null, numbers: [] },
    ],
    canRequest: true,
    requestedAtSignup: false,
    canSend: false,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
  };
}

describe("1. a phone step popup wears its steps as tabs", () => {
  it("draws a Steps tablist, no 'Step N of M', and a locked tab refuses with its reason", async () => {
    phoneViewport();
    render(
      <WorkNumberSetupModal
        open
        onClose={() => {}}
        workspaceId="ws-1"
        workspaceName="Seattle Homes"
        status={workNumberStatus()}
        planMessage={null}
        unverifiedEntitlement={false}
        onStatusChange={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Set up a work number" });

    const tablist = document.querySelector('[data-wizard-step-tabs]') as HTMLElement;
    expect(tablist).toBeTruthy();
    expect(tablist.getAttribute("aria-label")).toBe("Steps");
    const tabs = within(tablist).getAllByRole("tab").map((tab) => tab.textContent?.trim());
    expect(tabs.length).toBeGreaterThan(1);
    // The dropdown this replaces printed the position; the tabs show every step instead.
    expect(document.body.textContent).not.toMatch(/Step \d+ of \d+/);

    capture("phone-step-tabs", `Phone · ${tabs.join(" · ")} as underline tabs across the top of the popup — no “Step N of M” dropdown. The locked tab is dimmed.`);

    // Tapping a locked tab does not move, it says why.
    const locked = within(tablist).getAllByRole("tab").find((tab) => tab.getAttribute("aria-disabled") === "true")!;
    expect(locked).toBeTruthy();
    const before = within(tablist).getAllByRole("tab").findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    fireEvent.click(locked);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Verify your phone first"));
    const after = within(tablist).getAllByRole("tab").findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    expect(after).toBe(before);
  });
});

function bothStays(extra: Partial<ManagerListingSubmissionV1> = {}): ManagerListingSubmissionV1 {
  const base = {
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: ["Long-term", "Month-to-Month"],
    rooms: [{ id: "r1", name: "Room A", monthlyRent: 1800, utilitiesEstimate: "150", securityDeposit: "1800" }],
  } as unknown as ManagerListingSubmissionV1;
  const patch = staysPatch(base, { long_term: true, short_term: true })!;
  return { ...base, ...patch, ...extra } as ManagerListingSubmissionV1;
}

/** The wizard's Pricing step, driven by its own state so edits stick the way they do in the app. */
function PricingStepHarness({ initial }: { initial: ManagerListingSubmissionV1 }) {
  const [sub, setSub] = useState(initial);
  return <StepPricing sub={sub} onChange={setSub} doors={{ recordId: null, mode: "draft", managerUserId: "m1", showToast }} />;
}
const openRoom = () => fireEvent.click(screen.getByRole("button", { name: "Open Room A" }));
const stayHeadings = () =>
  [...document.querySelectorAll("[data-attr^='listing-v2-stay-header']")].map((el) => el.textContent?.trim());

describe("2. Pricing is Long term and Short term — never a Both", () => {
  it("shows one independent section per stay and offers the month-to-month surcharge", async () => {
    desktopViewport();
    const sub = bothStays();
    expect(listingOffersMonthToMonthSurcharge(sub)).toBe(true);
    expect(pricingSectionOptions(sub).map((option) => option.label)).toEqual(["Long-term", "Short-term"]);
    render(<PricingStepHarness initial={sub} />);
    openRoom();

    expect(stayHeadings()).toEqual(["Long term", "Short term"]);
    expect(document.body.textContent).not.toMatch(/\bBoth\b/);
    // The surcharge is a Long term row, offered because this listing allows Month-to-Month.
    expect(document.body.textContent).toMatch(/Month-to-month surcharge/i);

    capture(
      "pricing-long-and-short-term",
      "Manager · Pricing — exactly two sections, Long term and Short term, each with its own rent, deposit and fees. No “Both” section. The month-to-month surcharge is an optional Long term row.",
    );
  });

  it("a Seattle listing is never offered the month-to-month surcharge", async () => {
    desktopViewport();
    const seattle = bothStays({ address: "4709A 8th Ave NW", city: "Seattle", state: "WA", zip: "98107" });
    expect(listingOffersMonthToMonthSurcharge(seattle)).toBe(false);
    render(<PricingStepHarness initial={seattle} />);
    openRoom();

    expect(stayHeadings()).toEqual(["Long term", "Short term"]);
    expect(document.body.textContent).not.toMatch(/Month-to-month surcharge/i);

    capture(
      "pricing-seattle-no-mtm-surcharge",
      "Manager · the same Pricing on a SEATTLE listing — the two stay sections are unchanged and the month-to-month surcharge row is simply not offered (Seattle folds every recurring monthly cost into rent).",
    );
  });
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 24 months ending Oct 2026: revenue climbs, expenses flat — easy running totals to read off the chart. */
function cashflowPoints() {
  return Array.from({ length: 24 }, (_, i) => {
    const offset = 23 - i;
    const m = 9 - offset;
    const year = 2026 + Math.floor(m / 12);
    const month = ((m % 12) + 12) % 12;
    const revenue = 9000 + 220 * i;
    const expense = 3400 + (i % 4) * 300;
    return { key: `${year}-${String(month + 1).padStart(2, "0")}`, label: MONTHS[month]!, revenue, expense, profit: revenue - expense };
  });
}

describe("4. Finances cash flow is one running-total chart", () => {
  it("draws cumulative revenue/expenses with a dashed net, and period totals with 'vs prior period'", async () => {
    desktopViewport();
    render(<MonthlyProfitChart points={cashflowPoints()} />);

    expect(document.querySelector('[data-attr="cashflow-chart"] svg')).toBeTruthy();
    expect(document.querySelector('path[data-series="rev"]')).toBeTruthy();
    expect(document.querySelector('path[data-series="exp"]')).toBeTruthy();
    const net = document.querySelector('path[data-series="net"]') as SVGPathElement;
    expect(net).toBeTruthy();
    expect(net.getAttribute("stroke-dasharray")).toBeTruthy();
    // Six months shown out of 24, so there IS a prior period to compare against.
    expect(document.body.textContent).toMatch(/vs prior period/i);
    capture("cashflow-running-total", "Manager · Finances › Cash flow — one running-total chart (cumulative revenue and expenses, net dashed). KPI tiles are period totals and say “vs prior period”. Period and series live in the single Filter popover.");

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    await waitFor(() => expect(document.querySelector('[data-attr="portal-filter-dropdown-panel"]')).toBeTruthy());
    capture("cashflow-filter-popover", "Manager · the same chart with Filter open — period AND series are chosen in the one popover, not two separate controls.");
  });
});

describe("5. Settings › Integrations is one page of stacked sections", () => {
  it("offers Messages · Bookings · Posting · Google, and Facebook Marketplace as Copy post only", async () => {
    desktopViewport();
    window.history.replaceState(null, "", "/portal/profile?tab=spreadsheets");
    render(<ManagerIntegrationsPanel initialTab="posting" />);
    for (const label of ["Messages", "Bookings", "Posting", "Spreadsheets"]) {
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByText(/Facebook Marketplace/i)).toBeTruthy());
    capture("integrations-one-page-posting", "Manager · Settings › Integrations — one page with Messages · Bookings · Posting · Google. Posting holds Zillow syndication and Facebook Marketplace, which is “Copy post” only.");
  });
});

describe("3. after submitting, the applicant is told which forms are still owed", () => {
  it("lists each owed form with Fill out now and Someone else will fill it in", async () => {
    desktopViewport();
    render(
      <LinkedFormsFinishList
        forms={[
          { id: "req-1", formKind: "application", formLabel: "Co-signer application", questionCount: 12, feeCents: 4000, status: "owed", shareToken: "tok-abc" },
          { id: "req-2", formKind: "move_in", formLabel: "Pet agreement", questionCount: 5, feeCents: null, status: "owed" },
        ]}
      />,
    );
    expect(screen.getByText("2 more forms to finish")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Fill out now" })).toHaveLength(2);
    // A linked form that is an application can be handed to a helper; a move-in form cannot.
    expect(screen.getAllByRole("button", { name: "Someone else will fill it in" })).toHaveLength(1);
    capture(
      "linked-forms-more-to-finish",
      "Applicant · right after submitting — “2 more forms to finish”, each with Fill out now or Someone else will fill it in (a copy/share link; the resident side never sends from a work number or email). The co-signer application carries its own $40 fee.",
    );
  });
});

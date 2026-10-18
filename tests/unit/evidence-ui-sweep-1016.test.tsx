// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the Oct 16 portal sweep (studio plan codex-1/ui-sweep-1016).
//
// Renders the REAL surfaces the sweep changed and dumps each one as a full HTML page under
// EVIDENCE_DIR, so `tests/browser/ui-sweep-1016.config.ts` can paint them with the app's own
// Tailwind build and screenshot what a manager / prospect actually sees:
//
//   1. A pop-up fits its content (Customize dashboard, Send a message) — no fixed 920 x 640
//      window on desktop; a phone still gets the full sheet.
//   2. A failed attachment blocks the reply: the Send control is disabled and says why.
//   3. The inbox work-identity box ellipsizes a long address instead of spilling, and a failed
//      status read offers its retry.
//   4. One monthly figure per room on the public tour scheduler — a daily-priced room reads as
//      its 30-day amount, every amount with thousands separators.
//   5. The tour scheduler's empty state is an answer about the property, with a way to reach
//      the manager.
//   6. The generated room lease: no Date of birth line, the floor said once, the deposit
//      sentence complete, and no handwritten signature lines.
import { useState } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MockProperty } from "@/data/types";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; caption: string; html: string }[] = [];

/** The whole body: a pop-up renders into a portal, not into the container. */
function capture(name: string, caption: string) {
  captured.push({ name, caption, html: document.body.innerHTML });
}

/** A standalone document (the lease templates carry their own CSS). */
const standalone: { name: string; html: string }[] = [];

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, caption, html } of captured) {
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.html`),
      `<!doctype html><html lang="en" data-theme="light" class="h-full antialiased">
<head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="position:relative;z-index:2147483647;font:600 13px/1.5 system-ui;color:#475569;margin:12px 16px;max-width:1100px;white-space:pre-line">${caption}</p>
${html}</body></html>`,
      "utf8",
    );
  }
  for (const { name, html } of standalone) writeFileSync(join(EVIDENCE_DIR, `${name}.html`), html, "utf8");
});

const statusState = vi.fn();
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => statusState(),
}));
// The card reads the workspace's work email through the shared GET cache; answer it with a
// long address, which is the one the box has to ellipsize.
vi.mock("@/lib/shared-get-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shared-get-cache")>()),
  sharedGet: async () => ({
    ok: true,
    status: 200,
    data: {
      canRequest: false,
      canUse: true,
      planTier: "paid",
      entitlement: { eligible: true, tier: "pro", source: "stripe" },
      workspaceEmail: { address: "ballard-house-management-team@proplane-workspaces.app" },
    },
  }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { AdminComposeModal } from "@/components/portal/admin-compose-modal";
import { DashboardCustomizeModal } from "@/components/portal/dashboard-customize-modal";
import { InboxComposer } from "@/components/portal/portal-inbox-ui";
import { ManagerWorkNumberCard } from "@/components/portal/pro-work-number-card";
import { TourScheduleFlow } from "@/components/marketing/tour-schedule-flow";
import { INBOX_ATTACHMENT_FAILED_MESSAGE } from "@/lib/inbox-attachment-send-gate";
import { MANAGER_DASHBOARD_SECTIONS } from "@/lib/dashboard-preferences";
import { snapshotJordanLee } from "@/data/manager-application-snapshots";
import { leaseContextFromApplication } from "@/lib/generated-lease";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";
import { emptyRoom } from "@/lib/manager-listing-submission";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * A pop-up asks the viewport which presentation it is: a desktop pointer gets the Radix dialog
 * (the frame this sweep resized), a phone gets the Vaul sheet. jsdom answers "no" to every query,
 * which is the phone answer — so the desktop shots stub the desktop answer, exactly like
 * `tests/unit/modal-fit-content-frame.test.tsx`.
 */
function desktopViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine") || query.includes("min-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
}

function customizeDashboard() {
  return render(
    <AppUiProvider>
      <DashboardCustomizeModal
        open
        onClose={() => {}}
        visibility={Object.fromEntries(MANAGER_DASHBOARD_SECTIONS.slice(0, 4).map((s) => [s.id, true]))}
        onToggle={() => {}}
        onReset={() => {}}
        sections={MANAGER_DASHBOARD_SECTIONS.slice(0, 4)}
      />
    </AppUiProvider>,
  );
}

function adminCompose() {
  return render(
    <AppUiProvider>
      <AdminComposeModal
        open
        onClose={() => {}}
        onSent={() => {}}
        recipients={{
          managers: [
            { id: "m1", name: "Ada Lovelace", email: "ada@example.com", meta: "Ballard House" },
            { id: "m2", name: "Grace Hopper", email: "grace@example.com", meta: "Fremont House" },
          ],
          residents: [{ id: "r1", name: "Rae Resident", email: "rae@example.com", meta: "Room 3" }],
        }}
      />
    </AppUiProvider>,
  );
}

describe("a pop-up fits its content", () => {
  it("Customize dashboard is a card the size of its toggle list", () => {
    desktopViewport();
    customizeDashboard();
    expect(screen.getByText("Customize dashboard")).toBeTruthy();
    expect(document.querySelector('[data-slot="modal-radix-dialog"]')?.className).toContain("!h-auto");
    capture(
      "01-popup-fit-customize-dashboard",
      "Pop-up fit (decision 3): four toggles, so the panel is the height of four toggles — not the old fixed 920 x 640 window. The paint pass measures the panel.",
    );
  });

  it("is still the full sheet on a phone", () => {
    customizeDashboard();
    expect(document.querySelector('[data-slot="modal-vaul-drawer"]')).toBeTruthy();
    capture("01b-popup-phone-sheet-customize-dashboard", "The same pop-up on a phone: unchanged full sheet.");
  });

  it("the admin Send a message pop-up is the shared dialog with the shared fields", () => {
    desktopViewport();
    adminCompose();
    expect(document.querySelector('[data-slot="modal-radix-dialog"]')?.className).toContain("!h-auto");
    capture(
      "02-popup-fit-admin-compose",
      "Admin Send a message, moved onto the shared PortalDialog and the shared recipient / topic / message fields — and sized to them.",
    );
  });

  it("the admin pop-up is the full sheet on a phone too", () => {
    adminCompose();
    expect(document.querySelector('[data-slot="modal-vaul-drawer"]')).toBeTruthy();
    capture("02b-popup-phone-sheet-admin-compose", "Admin Send a message on a phone: unchanged full sheet.");
  });
});

describe("a failed attachment blocks the reply", () => {
  it("disables Send and says why", () => {
    render(
      <AppUiProvider>
        <div className="mx-4 max-w-[760px] rounded-xl border border-border bg-card p-3">
          <InboxComposer
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            dataAttr="evidence-composer"
            attachments={[
              { id: "a1", fileName: "lease-addendum.pdf", previewUrl: "", error: "Upload failed" },
              { id: "a2", fileName: "ready.pdf", previewUrl: "" },
            ]}
            onAttachmentRemove={() => {}}
          />
        </div>
      </AppUiProvider>,
    );
    const send = document.querySelector<HTMLButtonElement>('[data-attr="evidence-composer-send"]')!;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("title")).toBe(INBOX_ATTACHMENT_FAILED_MESSAGE);
    capture(
      "03-inbox-failed-attachment-blocks-send",
      `A failed upload now blocks the send instead of leaving quietly without the file. Send is disabled and both the chip and the button say: "${INBOX_ATTACHMENT_FAILED_MESSAGE}"`,
    );
  });
});

function numberStatus(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    number: {
      state: "active",
      registrationState: "approved",
      carrierRegistrationState: "registered",
      attachmentState: "attached",
      phoneNumber: "+12069228062",
      lastError: null,
    },
    canRequest: false,
    canSend: true,
    ...overrides,
  } as ManagerMessagingNumberStatus;
}

describe("the inbox work-identity boxes", () => {
  it("hold a long work email inside the box", async () => {
    statusState.mockReturnValue({ ready: true, resolved: true, statusError: null, status: numberStatus(), retry: () => {} });
    render(
      <AppUiProvider>
        <div className="mx-4 max-w-[560px]">
          <ManagerWorkNumberCard />
        </div>
      </AppUiProvider>,
    );
    await screen.findByText("ballard-house-management-team@proplane-workspaces.app");
    capture(
      "04-inbox-work-identity-boxes",
      'Work number / Work email: the label reads as a pair and a long address ellipsizes inside its box instead of spilling out of it.',
    );
  });

  it("offers the retry when the status read failed", () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: false,
      statusError: "We couldn't load your work number just now.",
      status: null,
      retry: () => {},
    });
    render(
      <AppUiProvider>
        <div className="mx-4 max-w-[560px]">
          <ManagerWorkNumberCard />
        </div>
      </AppUiProvider>,
    );
    capture(
      "05-inbox-work-identity-status-failed",
      "A failed work-number status read is shown as a failed read with its own retry (it auto-retries once first), never as 'no number'.",
    );
  });
});

const ROOMS = [
  { ...emptyRoom(0), id: "r1", name: "Room 1", floor: "2nd floor", monthlyRent: 1000 },
  { ...emptyRoom(1), id: "r2", name: "Room 2", floor: "2nd floor", monthlyRent: 2150 },
  // Priced by the day: the scheduler must read its 30-day amount ($45 x 30 = $1,350/mo),
  // never the stored monthlyRent of 1050.
  { ...emptyRoom(2), id: "r3", name: "Room 3", floor: "Main floor", monthlyRent: 1050, rentBasis: "daily", dailyRentPrice: 45 },
];

const PROPERTY: MockProperty = {
  id: "mgr-ballard-1",
  title: "Ballard House",
  tagline: "Bright rooms near the locks",
  address: "1 Ballard Ave",
  zip: "98107",
  neighborhood: "Ballard",
  beds: 3,
  baths: 2,
  rentLabel: "$1,200/mo",
  available: "Now",
  petFriendly: true,
  buildingId: "mgr-ballard",
  buildingName: "Ballard House",
  unitLabel: "Room A",
  listingSubmission: { v: 1, bathrooms: [], sharedSpaces: [], rooms: ROOMS } as unknown as MockProperty["listingSubmission"],
};

function stubAvailability(body: unknown, ok = true, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response));
}

describe("the public tour scheduler", () => {
  it("prices every room once, monthly, with separators — a daily room by its 30-day amount", async () => {
    stubAvailability({ slotHosts: {} });
    render(
      <AppUiProvider>
        <div className="mx-auto max-w-[860px] p-4">
          <TourScheduleFlow property={PROPERTY} returnAfterAuth="/rent" onSuccess={() => {}} />
        </div>
      </AppUiProvider>,
    );
    expect(await screen.findByText("Room 2 · 2nd floor · $2,150/mo")).toBeTruthy();
    expect(screen.getByText("Room 3 · Main floor · $1,350/mo")).toBeTruthy();
    expect(screen.getByText("Room 1 · 2nd floor · $1,000/mo")).toBeTruthy();
    capture(
      "06-tour-rooms-one-monthly-price",
      "One monthly figure per room: Room 3 is priced by the day ($45/day) and reads as its 30-day amount, $1,350/mo. Every amount carries thousands separators.",
    );
  });

  it("answers an empty calendar as an answer, with a way to reach the manager", async () => {
    stubAvailability({ slotHosts: {} });
    render(
      <AppUiProvider>
        <div className="mx-auto max-w-[860px] p-4">
          <TourScheduleFlow
            property={{ ...PROPERTY, contactSmsPhone: "+12065550123" }}
            returnAfterAuth="/rent"
            onSuccess={() => {}}
          />
        </div>
      </AppUiProvider>,
    );
    fireEvent.click(await screen.findByText("Room 1 · 2nd floor · $1,000/mo"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText(/No tour times yet/i)).toBeTruthy());
    expect(screen.getByText("Message the manager")).toBeTruthy();
    capture(
      "07-tour-empty-state",
      "A successful but empty availability read is the property's own answer — 'No tour times yet' plus Message the manager. A throttled or failed read shows a retry instead (next shot).",
    );
  });

  it("shows a throttled read as a read to retry, not as no availability", async () => {
    stubAvailability({ error: "Too many requests. Please slow down." }, false, 429);
    render(
      <AppUiProvider>
        <div className="mx-auto max-w-[860px] p-4">
          <TourScheduleFlow property={PROPERTY} returnAfterAuth="/rent" onSuccess={() => {}} />
        </div>
      </AppUiProvider>,
    );
    fireEvent.click(await screen.findByText("Room 1 · 2nd floor · $1,000/mo"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    expect(screen.queryByText(/No tour times yet/i)).toBeNull();
    capture(
      "08-tour-read-failure-retry",
      "The same screen after a throttled (429) availability read: a try-again message, never a confident 'no availability' for a house with a full calendar.",
    );
  });
});

describe("the generated room lease", () => {
  it("names the resident but carries no birth date, SSN or licence", () => {
    const application = {
      ...snapshotJordanLee(),
      dateOfBirth: "1998-03-14",
      ssn: "123-45-6789",
      driversLicense: "D1234567",
    };
    const html = buildLeaseHtml(leaseContextFromApplication(application), WASHINGTON_LEASE_CONFIG);
    expect(html).toContain(application.fullLegalName);
    expect(html).not.toMatch(/date of birth/i);
    for (const secret of ["1998-03-14", "123-45-6789", "D1234567"]) expect(html).not.toContain(secret);
    expect(html).not.toContain("Landlord signature: ____");
    standalone.push({ name: "09-lease-room-no-birth-date", html });
  });
});

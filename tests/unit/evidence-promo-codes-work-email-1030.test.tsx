// @vitest-environment jsdom
//
// Reviewer evidence for the promo-code / service work-email lane: the four screens a person actually touches.
//
//   * Communication "Work email" box with the Edit pencil a PropLane-managed workspace now gets, and the
//     Work email dialog it opens (live availability from `check_address`).
//   * Settings -> Leasing -> Waive codes listing a code the viewer may edit beside the house owner's
//     portfolio-wide code, which the server marked `readOnly` and the row renders with every control inert.
//   * A listing's Promo codes row for a `readOnly` code: Copy stays (handing the text to an applicant is the
//     everyday action), Manage codes / Turn off are gone because `PATCH /[id]` would refuse them.
//
// Renders the REAL components over the payloads the routes answer. With EVIDENCE_DIR set each surface is dumped
// for tests/browser/promo-work-email-1030 to paint:
//
//   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-promo-codes-work-email-1030.test.tsx
//   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/promo-work-email-1030.config.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { writeEvidenceSurface } from "../helpers/evidence-dom";
import type { ApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const toast = vi.hoisted(() => vi.fn());
const statusState = vi.fn();

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => statusState(),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: toast }),
  useOptionalAppUi: () => ({ showToast: toast }),
  useConfirm: () => () => Promise.resolve(true),
}));

import { ManagerWorkNumberCard } from "@/components/portal/pro-work-number-card";
import { WaiveCodesSettingsSection } from "@/components/portal/settings-waive-codes-section";
import { FormPromoCodesRow } from "@/components/portal/form-promo-codes";
import { resetSharedGets } from "@/lib/shared-get-cache";

const DOMAIN = "proplane.ai";

function numberStatus(): ManagerMessagingNumberStatus {
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
    requestedAtSignup: false,
    canSend: true,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
  };
}

/** What `GET /api/manager/assistant-email` answers staff on a PropLane-managed workspace. */
function serviceEmailPayload(address: string) {
  return {
    provisioningAvailable: true,
    sendingAvailable: true,
    receivingAvailable: true,
    storageReady: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    workspaceRole: "co_manager",
    workspaceEmail: { address, ownerUserId: "proplane-service-owner", ownerName: "PropLane" },
    workspace: { id: "ws-ambika", name: "1. Ambika", owned: false, isDefault: false },
    address,
    canEditAddress: true,
    state: "ready",
    canRequest: false,
    canUse: true,
    requestedAtSignup: false,
  };
}

function stubServiceEmail() {
  let address = `ambikahomes@${DOMAIN}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("/api/manager/assistant-email")) return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action?: string; local?: string };
        if (body.action === "check_address") return Response.json({ ok: true, state: "available" });
        address = `${body.local}@${DOMAIN}`;
        return Response.json(serviceEmailPayload(address));
      }
      return Response.json(serviceEmailPayload(address));
    }),
  );
}

function waiverCode(over: Partial<ApplicationFeeWaiverCode> = {}): ApplicationFeeWaiverCode {
  return {
    id: "code-appwaive",
    managerUserId: "owner-1",
    code: "APPWAIVE",
    label: "Open house waiver",
    propertyId: null,
    propertyIds: ["house-brooklyn"],
    appliesTo: "application",
    status: "active",
    maxUses: null,
    usedCount: 3,
    expiresAt: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

/** The two rows Settings shows a seated teammate: their own code, and the owner's portfolio-wide one. */
const LISTED_CODES: ApplicationFeeWaiverCode[] = [
  waiverCode(),
  waiverCode({
    id: "code-ownerwide",
    code: "OWNERWIDE",
    label: "Owner portfolio code",
    propertyIds: [],
    usedCount: 11,
    readOnly: true,
  }),
];

function stubWaiverList(codes: ApplicationFeeWaiverCode[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/manager/application-fee-waivers")) return Response.json({ codes });
      return new Response(null, { status: 404 });
    }),
  );
}

afterEach(() => {
  resetSharedGets();
  cleanup();
  vi.unstubAllGlobals();
  statusState.mockReset();
});

describe("evidence: service work email", () => {
  it("the Work email box carries an Edit pencil for staff of a PropLane-managed workspace", async () => {
    statusState.mockReturnValue({ ready: true, resolved: true, statusError: false, status: numberStatus(), retry: () => {} });
    stubServiceEmail();

    render(<ManagerWorkNumberCard />);

    await waitFor(() => expect(screen.getByText(`ambikahomes@${DOMAIN}`)).toBeTruthy());
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("data-attr")).toBe("manager-work-email-edit");
    writeEvidenceSurface("10-work-email-card-edit", "Communication → work identity: the PropLane-managed workspace's work email, with the Edit pencil staff now get");

    fireEvent.click(edit);
    const input = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(input.value).toBe("ambikahomes");
    fireEvent.change(input, { target: { value: "ambika.front" } });
    await waitFor(() => expect(screen.getByText("Available")).toBeTruthy());
    writeEvidenceSurface("11-work-email-dialog-available", 'Work email dialog: the local part is editable beside the fixed domain, availability answered live by check_address', 160);
  });
});

describe("evidence: waive / promo codes", () => {
  it("Settings lists the owner's portfolio-wide code read-only beside an editable one", async () => {
    stubWaiverList(LISTED_CODES);

    render(
      <WaiveCodesSettingsSection
        propertyOptions={[
          { id: "house-brooklyn", label: "5257 Brooklyn Ave NE" },
          { id: "house-pike", label: "400 Pike St" },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByText("APPWAIVE")).toBeTruthy());
    expect(screen.getByText("OWNERWIDE")).toBeTruthy();
    // The editable row keeps its Disable control; the read-only row offers none.
    expect(screen.getAllByRole("button", { name: "Disable code" })).toHaveLength(1);
    const appliesTo = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-attr="waive-codes-row-applies-to"]'),
    );
    expect(appliesTo.map((el) => el.disabled)).toEqual([false, true]);
    writeEvidenceSurface(
      "20-settings-waive-codes",
      "Settings → Leasing → Waive codes, seen by a Leasing co-manager: APPWAIVE (theirs to edit) above the house owner's portfolio-wide OWNERWIDE, listed read-only",
      200,
    );
  });

  it("a read-only code's ⋯ menu keeps Copy and drops the writes", async () => {
    stubWaiverList([waiverCode({ readOnly: true })]);

    render(
      <FormPromoCodesRow
        kind="application"
        propertyId="house-brooklyn"
        propertyLabel="5257 Brooklyn Ave NE"
        dataAttr="application-promo-code"
        variant="wizard"
      />,
    );

    await waitFor(() => expect(screen.getByText("APPWAIVE")).toBeTruthy());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for APPWAIVE" }), {
      pointerType: "mouse",
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy" })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: "Manage codes" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Turn off" })).toBeNull();
    writeEvidenceSurface(
      "21-form-promo-codes-menu",
      "A listing's Promo codes row for a code the viewer may not change: Copy stays, Manage codes and Turn off are gone",
      240,
    );
  });
});

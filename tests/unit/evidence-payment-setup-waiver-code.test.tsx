// @vitest-environment jsdom
//
// EVIDENCE HARNESS — "PropLane covers it" asks for the promo code (captain
// decision September 12, 2026, reversing the staff-only rule of September 10).
//
// Drives the REAL Payment setup dialog through the four states a manager sees:
// the three fee-payer choices; the inline code field that opens on picking
// "PropLane covers it"; the refusal when the code is wrong; and the applied
// line once FREE100 checks out. Nothing is saved until the code checks out —
// the PATCH log is asserted at each step.
//
// Set EVIDENCE_DIR to dump each state's HTML so it can be screenshotted with
// the app's real stylesheet.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ReactNode } from "react";

const OUT = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; caption: string; body: string }[] = [];
function shot(name: string, caption: string, body: string) {
  captured.push({ name, caption, body });
}
afterAll(() => {
  if (!OUT || captured.length === 0) return;
  mkdirSync(OUT, { recursive: true });
  for (const { name, caption, body } of captured) {
    writeFileSync(`${OUT}/${name}.body.html`, body, "utf8");
    writeFileSync(`${OUT}/${name}.caption.txt`, caption, "utf8");
  }
});

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
 useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false, DEMO_MANAGER_USER_ID: "demo-manager" }));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerSubscriptionTierClient: vi.fn(async () => "pro"),
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
vi.mock("@/lib/stripe-connect-onboarding-client", () => ({
  openStripeConnectOnboarding: vi.fn(async () => undefined),
}));
// The shared Modal portals into document.body, which `container.innerHTML`
// cannot capture. Render it inline so the screenshot shows the real dialog card.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer, title }: { open: boolean; children: ReactNode; footer?: ReactNode; title?: ReactNode }) =>
    open ? (
      <div role="dialog" className="modal-panel mx-auto my-6 w-full max-w-xl rounded-2xl border border-border bg-card p-5 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-foreground">{title}</h2>
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div className="mt-4 flex justify-end gap-2">{children}</div>,
}));

import { ManagerPaymentSetupModal } from "@/components/portal/pro-payment-setup-modal";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  PROCESSING_FEE_PROPLANE_PENDING_LABEL,
  SERVICE_FEE_PAYER_OPTION_LABELS,
} from "@/lib/payment-policy";

let patches: Record<string, unknown>[] = [];

function respond(url: string, init?: RequestInit) {
  if (url.startsWith("/api/stripe/connect/status")) {
    return { ok: true, status: 200, json: async () => ({ connected: true, paymentReady: true, payoutsEnabled: true }) };
  }
  if (url.startsWith("/api/manager/subscription")) {
    return { ok: true, status: 200, json: async () => ({ tier: "pro" }) };
  }
  if (url.startsWith("/api/portal/manager-manual-payment-settings")) {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      patches.push(body);
      return { ok: true, status: 200, json: async () => ({ settings: { ...body } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ settings: { axisPaymentsEnabled: true, serviceFeePayer: "resident" } }),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function feeCard(): string {
  // The fee-payer block is what this change touches; screenshot that card.
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).toBeTruthy();
  return dialog!.outerHTML;
}

async function click(dataAttr: string) {
  const el = document.querySelector<HTMLElement>(`[data-attr="${dataAttr}"]`);
  expect(el, dataAttr).toBeTruthy();
  await act(async () => {
    el!.click();
  });
}

async function typeCode(value: string) {
  const input = document.querySelector<HTMLInputElement>('[data-attr="manager-service-fee-waiver-code"]');
  expect(input, "waiver code field").toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("evidence · PropLane covers it requires the promo code", () => {
  it("walks the dialog from the choice to the applied code", async () => {
    await act(async () => {
      render(
        <ManagerPaymentSetupModal
          open
          onClose={vi.fn()}
          portalBase="/portal"
          propertyOptions={[{ id: "home", label: "5259 Brooklyn Ave NE" }]}
          presetPropertyIds={["home"]}
        />,
      );
    });

    shot(
      "payment-setup-01-fee-choices",
      "Payment setup · who pays the processing fee — 'Resident pays' is the stored choice.",
      feeCard(),
    );

    // 1. PropLane pays is offered outright, but PICKING it is not a save: the
    //    select holds the pick, the code field opens, and the answer in force is
    //    named so the pending pick never reads as saved.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Processing fee paid by", expanded: false }));
    });
    const option = within(screen.getByRole("listbox")).getByText(SERVICE_FEE_PAYER_OPTION_LABELS.proplane);
    await act(async () => {
      fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    });
    expect(document.querySelector('[data-attr="manager-service-fee-waiver-code"]')).toBeTruthy();
    expect(document.body.textContent).toContain(PROCESSING_FEE_PROPLANE_PENDING_LABEL);
    expect(document.body.textContent).toContain("Resident pays stays in effect until it is applied.");
    expect(patches).toHaveLength(0);
    shot(
      "payment-setup-02-code-required",
      "Picking 'PropLane pays' opens the coverage-code field under the select, marked 'Not applied yet'. No save was sent (0 PATCH requests); Resident pays is still in force.",
      feeCard(),
    );

    // 2. Malformed input is refused inline, with nothing written. Shape is all
    //    the browser may judge — the coverage codes are server-only now, because
    //    one of them was readable in a client chunk and a code is a credential.
    await typeCode("NO");
    await click("manager-service-fee-waiver-apply");
    expect(patches).toHaveLength(0);
    // The refusal message is the shared one, so the product never prints the code
    // itself back at a manager who does not have it.
    expect(document.body.textContent).toContain(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID);
    shot(
      "payment-setup-03-wrong-code",
      "Malformed input is refused inline — still 0 PATCH requests, so nothing was stored.",
      feeCard(),
    );

    // 3. A well-formed code is SENT for the server to judge; the route checks it
    //    against the server-only list and refuses anything that is not real.
    await typeCode("free100");
    await click("manager-service-fee-waiver-apply");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });
    shot(
      "payment-setup-04-code-applied",
      "FREE100 checks out: the code field closes and 'PropLane pays' is the saved answer (PATCH serviceFeePayer=proplane, serviceFeeWaiverCode=FREE100).",
      feeCard(),
    );
  });
});

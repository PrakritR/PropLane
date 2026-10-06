// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the pop-ups whose primary action moved into the Modal
// footer slot (claude-1 d15c993bf, integrated on claude-2).
//
// Each pop-up is OPENED the way a manager opens it, and the primary button is
// then located in the DOM: it must sit inside the modal's pinned footer band
// (`[data-field-select-host-footer]`), never loose in the scrolling body
// (`[data-popup-form]`). `tests/unit/modal-save-in-footer.test.ts` pins the
// same rule in source; this one proves it on the rendered surface and dumps
// the HTML so the footer can be seen.
//
// Set EVIDENCE_DIR to dump each rendered pop-up so it can be screenshotted
// with the app's real stylesheet.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const captured: { name: string; html: string }[] = [];
function dump(name: string, html: string) {
  captured.push({ name, html });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) {
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.body.html`), html, "utf8");
  }
});

/**
 * The one thing every case asserts: the named button is in the modal's footer
 * band, and not in the scrolling form body above it.
 */
function expectInFooter(button: Element | null, label: string) {
  expect(button, `${label}: button not rendered`).toBeTruthy();
  expect(
    button!.closest("[data-field-select-host-footer]"),
    `${label}: primary action is not in the Modal footer slot`,
  ).toBeTruthy();
  expect(button!.closest("[data-popup-form]"), `${label}: primary action is still in the modal body`).toBeNull();
}

/** Route-aware stub so each panel's own loader settles with usable data. */
const routes: { match: RegExp; body: unknown }[] = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
  const hit = routes.find((r) => r.match.test(url));
  return new Response(JSON.stringify(hit?.body ?? { ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

let SEARCH = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/settings",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(SEARCH),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/hooks/use-is-native-app", () => ({ useIsNativeApp: () => ({ isNative: false }) }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerSubscriptionTierClient: async () => "pro",
  loadManagerPaymentWaiverGrantedClient: async () => false,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));

afterEach(() => {
  cleanup();
  routes.length = 0;
  SEARCH = "";
});

async function settle(ms = 200) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The portal select is a trigger + listbox, not a native `<select>`. */
async function pickOption(trigger: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.click(trigger);
  });
  const listbox = await waitFor(() => {
    const el = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(el, "option list did not open").toBeTruthy();
    return el!;
  });
  const option = listbox.querySelector(`[data-field-select-option-value="${value}"]`)!;
  expect(option, `option ${value} not offered`).toBeTruthy();
  await act(async () => {
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
  });
}

describe("pop-up primary action renders in the Modal footer", () => {
  it("Change plan — the switch button", async () => {
    const { PlanAdjustSheet } = await import("@/components/portal/pro-plan-adjust-sheet");
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="free"
        currentBilling="monthly"
        renewalLabel="Nov 1, 2026"
        busy={false}
        onConfirm={() => {}}
        residentCount={4}
      />,
    );
    await settle();
    expectInFooter(document.querySelector('[data-attr="plan-adjust-confirm"]'), "Change plan");
    dump("popup-change-plan", document.body.innerHTML);
  });

  it("Welcome sheet — Open welcome sheet", async () => {
    const { HousePrintablesCard } = await import("@/components/portal/house-printables-card");
    render(
      <HousePrintablesCard
        propertyId="mgr-evidence-house"
        rooms={[
          { id: "room-a", name: "Room A", floor: "" },
          { id: "room-b", name: "Room B", floor: "" },
        ]}
      />,
    );
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByText("Welcome sheet"));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expectInFooter(document.querySelector('[data-attr="house-printables-welcome"]'), "Welcome sheet");
    dump("popup-welcome-sheet", document.body.innerHTML);
  });

  it("Processing coverage code — Apply code", async () => {
    routes.push({
      match: /manual-payment/i,
      body: { settings: { serviceFeePayer: "resident", adminServiceFeeOverride: null, serviceFeeWaiverCode: null } },
    });
    const { AccountProcessingFeeSettings } = await import("@/components/portal/account-processing-fee-settings");
    render(<AccountProcessingFeeSettings />);
    await settle(300);
    // Picking "PropLane pays" is what asks for the coverage code.
    const host = document.querySelector('[data-attr="account-processing-fee-payer"]') as HTMLElement;
    expect(host, "fee payer picker not rendered").toBeTruthy();
    const picker = (host.matches("button") ? host : host.querySelector("button")) as HTMLElement;
    expect(picker, "fee payer trigger not rendered").toBeTruthy();
    await pickOption(picker, "proplane");
    await settle();
    expectInFooter(screen.getByRole("button", { name: "Apply code" }), "Processing coverage code");
    dump("popup-coverage-code", document.body.innerHTML);
  });

  it("Add credit — Add $…", async () => {
    const { MessagingCreditPanel } = await import("@/components/portal/messaging-credit-panel");
    render(
      <MessagingCreditPanel
        summary={{
          remainingCents: 1200,
          includedRemainingCents: 700,
          purchasedRemainingCents: 500,
          usedThisMonthCents: 2300,
          allowanceCents: 3000,
          periodEnd: "2026-11-01T00:00:00.000Z",
          paused: false,
          fundsAllWorkspaces: true,
          pinnedWorkspaceId: null,
          workspaces: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any}
        ratesCents={undefined}
        load={async () => null}
      />,
    );
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add credit" }));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expectInFooter(screen.getByRole("button", { name: /^Add \$/ }), "Add credit");
    dump("popup-add-credit", document.body.innerHTML);
  });

  it("Plan add-ons — Confirm payment", async () => {
    routes.push({
      match: /plan-addons/,
      body: {
        tier: "pro",
        canHoldAddons: true,
        monthlyTotalCents: 0,
        addons: [
          {
            id: "extra_workspace",
            label: "Extra workspace",
            unit: "workspace",
            description: "",
            monthlyCents: 1500,
            maxQuantity: 5,
            quantity: 0,
            purchasable: true,
          },
        ],
      },
    });
    const { ManagerPlanAddonsPanel } = await import("@/components/portal/manager-plan-addons-panel");
    render(<ManagerPlanAddonsPanel />);
    await settle(300);
    // Step the count up, then commit — a cost increase is what asks to confirm.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-attr="plan-addon-extra_workspace-add"]')!);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-attr="plan-addons-update"]')!);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expectInFooter(document.querySelector('[data-attr="plan-addons-confirm"]'), "Plan add-ons");
    dump("popup-plan-addons-confirm", document.body.innerHTML);
  });

  it("Add to your vendors — the confirm", async () => {
    SEARCH = "tab=catalog";
    routes.push({
      match: /vendor-directory/,
      body: {
        rows: [
          {
            catalogId: "dir-1",
            directoryVendorUserId: "vendor-user-1",
            name: "Sound Plumbing",
            trade: "Plumbing",
            trades: ["Plumbing"],
            city: "Seattle",
            description: "Licensed and bonded",
            rating: 4.8,
          },
        ],
      },
    });
    const { ManagerVendorsPanel } = await import("@/components/portal/pro-vendors-panel");
    render(<ManagerVendorsPanel />);
    await settle(500);
    // The directory vendor's own row — its ⋯ carries "Add to your vendors".
    const list = document.querySelector('[data-attr="vendor-catalog-list"]')!;
    const trigger = await waitFor(() => {
      const rows = [...list.querySelectorAll('[data-attr="vendor-catalog-row"]')];
      const index = rows.findIndex((node) => (node.textContent ?? "").includes("Sound Plumbing"));
      expect(index, "directory vendor row not rendered").toBeGreaterThan(-1);
      const triggers = [...list.querySelectorAll('[data-attr="record-actions-trigger"]')];
      expect(triggers.length, "row ⋯ menus missing").toBe(rows.length);
      return triggers[index] as HTMLElement;
    });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const add = await waitFor(() => {
      const el = document.querySelector('[data-attr="vendor-catalog-row-add"]');
      expect(el, "catalog row Add action not rendered").toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(add);
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expectInFooter(document.querySelector('[data-attr="vendor-directory-add-confirm"]'), "Add to your vendors");
    dump("popup-add-vendor-confirm", document.body.innerHTML);
  });

  it("Edit permissions — Save", async () => {
    routes.push({
      match: /invite-links/,
      body: {
        links: [
          {
            id: "lnk-1",
            teamRole: "viewer",
            houseScope: "all",
            assignedPropertyIds: ["prop-a"],
            propertyPermissions: {},
            workspacePermissions: {},
            expiresAt: null,
            usedAt: null,
            revokedAt: null,
            maxUses: null,
            usedCount: 0,
          },
        ],
      },
    });
    const { WorkspaceInviteLinkStrip } = await import("@/components/portal/workspace-invite-link-strip");
    render(
      <WorkspaceInviteLinkStrip
        workspaceId="ws-1"
        workspace={{ name: "Brooklyn", propertyIds: ["prop-a"], propertyLabels: { "prop-a": "5259 Brooklyn Ave NE" } }}
        canManage
        onEdit={() => {}}
      />,
    );
    await settle(400);
    const trigger = document.querySelector('[data-attr="workspace-invite-link-actions"]') as HTMLElement;
    expect(trigger, "⋯ menu not rendered").toBeTruthy();
    // Radix opens its menu from the keyboard in jsdom (pointer capture is unavailable).
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const edit = await waitFor(() => {
      const el = document.querySelector('[data-attr="workspace-invite-link-edit"]');
      expect(el, "Edit permissions menu item not rendered").toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(edit);
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expectInFooter(document.querySelector('[data-attr="workspace-invite-link-edit-save"]'), "Edit permissions");
    dump("popup-edit-permissions", document.body.innerHTML);
  });
});

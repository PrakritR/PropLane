// @vitest-environment jsdom
//
// "Promo codes" on an Application or Lease card: a code is typed IN the row and added (Enter works too). It goes
// through the EXISTING waive-code API as a full waive of this form's fee, limited to this property. The codes
// already on the form list underneath as plain rows (no pills) with a ⋯ menu. There is no second code system.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: toast }),
  useOptionalAppUi: () => ({ showToast: toast }),
  useConfirm: () => async () => true,
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { FormPromoCodesRow } from "@/components/portal/form-promo-codes";

function code(over: Partial<ApplicationFeeWaiverCode>): ApplicationFeeWaiverCode {
  return {
    id: "c1", managerUserId: "m1", code: "APPONLY", label: null, propertyId: null, propertyIds: [], appliesTo: "application",
    status: "active", maxUses: null, usedCount: 0, expiresAt: null, createdAt: "2026-10-01T00:00:00.000Z", revokedAt: null, ...over,
  };
}

const LIST = [
  code({}),
  code({ id: "c2", code: "LEASEONLY", appliesTo: "lease", maxUses: 10, usedCount: 1 }),
  code({ id: "c3", code: "BOTH", appliesTo: "both", usedCount: 3 }),
  code({ id: "c4", code: "OTHERHOUSE", appliesTo: "both", propertyIds: ["prop-9"] }),
  code({ id: "c5", code: "OLDONE", appliesTo: "both", status: "revoked" }),
];

const fetchMock = vi.fn();
let postResult: { ok: boolean; body: unknown };
beforeEach(() => {
  toast.mockReset();
  fetchMock.mockReset();
  postResult = { ok: true, body: { code: code({ id: "new", code: "WELCOME", appliesTo: "lease", propertyIds: ["prop-1"] }) } };
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return { ok: true, json: async () => ({ codes: LIST, redemptions: [] }) };
    if (init.method === "POST") return { ok: postResult.ok, json: async () => postResult.body };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const input = () => screen.getByPlaceholderText("Type a code") as HTMLInputElement;

async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  return screen.findAllByRole("menuitem");
}

describe("Promo codes row", () => {
  it("lists the codes that waive this form's fee on this property as plain rows with their uses, no pills", async () => {
    const { container } = render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    expect(screen.getByText("BOTH")).toBeTruthy();
    expect(screen.queryByText("APPONLY")).toBeNull();
    expect(screen.queryByText("OTHERHOUSE")).toBeNull();
    expect(screen.queryByText("OLDONE")).toBeNull();
    const rows = container.querySelectorAll("[data-attr='form-promo-code-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Free");
    expect(rows[0]!.textContent).toContain("Used 1 of 10");
    expect(rows[1]!.textContent).toContain("Used 3");
    expect(rows[1]!.textContent).not.toContain(" of ");
    for (const row of rows) expect(row.querySelector("[class*='rounded-full'],[class*='badge' i]")).toBeNull();
  });

  it("typing a code and pressing Add creates it for this fee and this property", async () => {
    render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    fireEvent.change(input(), { target: { value: " welcome " } });
    expect(input().value).toBe(" WELCOME ");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(url).toBe("/api/manager/application-fee-waivers");
    // Only the code text and the selectors: no manager id.
    expect(JSON.parse(String(init.body))).toEqual({ code: "WELCOME", appliesTo: "lease", propertyIds: ["prop-1"] });
    expect(await screen.findByText("WELCOME")).toBeTruthy();
    expect(input().value).toBe("");
  });

  it("an application card adds an application code, and Enter adds too", async () => {
    render(<FormPromoCodesRow variant="wizard" kind="application" propertyId="prop-1" dataAttr="app-promo" />);
    await screen.findByText("APPONLY");
    fireEvent.change(input(), { target: { value: "SPRING26" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ code: "SPRING26", appliesTo: "application", propertyIds: ["prop-1"] });
  });

  it("refuses a malformed code before any request", async () => {
    render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    fireEvent.change(input(), { target: { value: "ab" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/4-32/);
    expect(posts()).toHaveLength(0);
  });

  it("shows the server's duplicate error inline and keeps what was typed", async () => {
    postResult = { ok: false, body: { error: "You already have a code with that text." } };
    render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    fireEvent.change(input(), { target: { value: "BOTH" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You already have a code with that text.");
    expect(input().value).toBe("BOTH");
    // Typing again clears the message.
    fireEvent.change(input(), { target: { value: "BOTH2" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a brand-new draft is saved first (ensureSaved) and the code is created on the new property", async () => {
    const ensureSaved = vi.fn().mockResolvedValue("prop-new");
    render(<FormPromoCodesRow variant="fact" kind="application" propertyId={null} ensureSaved={ensureSaved} dataAttr="app-promo" />);
    fireEvent.change(input(), { target: { value: "FIRSTONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(ensureSaved).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ code: "FIRSTONE", appliesTo: "application", propertyIds: ["prop-new"] });
  });

  it("a draft that cannot be saved adds nothing", async () => {
    const ensureSaved = vi.fn().mockResolvedValue(null);
    render(<FormPromoCodesRow variant="fact" kind="application" propertyId={null} ensureSaved={ensureSaved} dataAttr="app-promo" />);
    fireEvent.change(input(), { target: { value: "FIRSTONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it("a saved property does not call ensureSaved", async () => {
    const ensureSaved = vi.fn().mockResolvedValue("other");
    render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" ensureSaved={ensureSaved} dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    fireEvent.change(input(), { target: { value: "WELCOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(ensureSaved).not.toHaveBeenCalled();
  });

  it("the row menu offers Copy, Manage codes and a red Turn off that asks to confirm", async () => {
    const { container } = render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    const items = await openMenu(screen.getByRole("button", { name: "Actions for LEASEONLY" }));
    expect(items.map((i) => i.textContent)).toEqual(["Copy", "Manage codes", "Turn off"]);
    expect(items[2]!.className).toContain("text-danger");
    fireEvent.click(items[2]!);
    // Nothing is sent until the tap confirm.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm turn off" }));
    await waitFor(() => expect(screen.queryByText("LEASEONLY")).toBeNull());
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/manager/application-fee-waivers/c2");
    expect(JSON.parse(String(patch[1].body))).toEqual({ action: "revoke" });
    expect(container.querySelectorAll("[data-attr='form-promo-code-row']")).toHaveLength(1);
  });

  it("Manage codes opens the full waive-code dialog for this fee", async () => {
    render(<FormPromoCodesRow variant="fact" kind="lease" propertyId="prop-1" propertyLabel="Cascade Lofts" dataAttr="lease-promo" />);
    await screen.findByText("LEASEONLY");
    const items = await openMenu(screen.getByRole("button", { name: "Actions for LEASEONLY" }));
    fireEvent.click(items[1]!);
    expect(await screen.findByText("Promo codes", { selector: "h1,h2,h3,[role='dialog'] *" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Add waive code" })).toBeTruthy();
  });
});

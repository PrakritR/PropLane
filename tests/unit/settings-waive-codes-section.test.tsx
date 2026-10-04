// @vitest-environment jsdom
//
// Settings -> Leasing -> Waive codes: create, edit in place, and disable codes. The rules are the server's
// (waive-codes-lib.test.ts, waive-codes-applies-to-sql.test.ts); this proves the screen sends what the manager
// chose and never shows a rule the server refused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: toast }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { WaiveCodesSettingsSection } from "@/components/portal/settings-waive-codes-section";

const PROPERTIES = [
  { id: "prop-1", label: "Cascade Lofts" },
  { id: "prop-2", label: "Pine Street" },
];

function code(over: Partial<ApplicationFeeWaiverCode>): ApplicationFeeWaiverCode {
  return {
    id: "c1",
    managerUserId: "m1",
    code: "SPRING25",
    label: null,
    propertyId: null,
    propertyIds: [],
    appliesTo: "both",
    status: "active",
    maxUses: 20,
    usedCount: 3,
    expiresAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

const fetchMock = vi.fn();
let stored: ApplicationFeeWaiverCode[];

beforeEach(() => {
  toast.mockReset();
  stored = [code({}), code({ id: "c2", code: "OLDPROMO", status: "revoked", appliesTo: "application", usedCount: 7 })];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) return { ok: true, json: async () => ({ codes: stored, redemptions: [] }) };
    return { ok: true, json: async () => ({ ok: true, code: stored[0] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method);

describe("Waive codes", () => {
  it("lists active codes with their uses, and disabled ones struck through", async () => {
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    expect(await screen.findByText("SPRING25")).toBeTruthy();
    expect(screen.getByText("3 of 20 used")).toBeTruthy();
    expect(screen.getByText("OLDPROMO")).toBeTruthy();
    expect(screen.getByText("Disabled · 7 used")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Disable code" })).toHaveLength(1);
  });

  it("says so when there are no codes", async () => {
    stored = [];
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    expect(await screen.findByText("No waive codes")).toBeTruthy();
  });

  it("creates a code that applies to what the tab says by default, on every property, with the cap and expiry typed", async () => {
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} defaultAppliesTo="lease" />);
    await screen.findByText("SPRING25");
    fireEvent.click(screen.getByRole("button", { name: "Add waive code" }));
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "move-in-5" } });
    fireEvent.change(document.querySelector("[data-attr='waive-codes-new-uses']") as HTMLInputElement, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create code" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0]!;
    expect(url).toBe("/api/manager/application-fee-waivers");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      code: "MOVE-IN-5",
      appliesTo: "lease",
      propertyIds: [],
      maxUses: 5,
      expiresAt: null,
    });
  });

  it("edits the use cap in place and saves when the field is left", async () => {
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    await screen.findByText("SPRING25");
    const uses = document.querySelector("[data-attr='waive-codes-row-uses']") as HTMLInputElement;
    expect(uses.value).toBe("20");
    fireEvent.change(uses, { target: { value: "40" } });
    expect(writes()).toHaveLength(0);
    fireEvent.blur(uses);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0]!;
    expect(url).toBe("/api/manager/application-fee-waivers/c1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "update", appliesTo: "both", propertyIds: [], maxUses: 40 });
  });

  it("leaving a field untouched sends nothing", async () => {
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    await screen.findByText("SPRING25");
    fireEvent.blur(document.querySelector("[data-attr='waive-codes-row-uses']") as HTMLInputElement);
    expect(writes()).toHaveLength(0);
  });

  it("puts the row back when the server refuses an edit", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method
        ? { ok: false, json: async () => ({ error: "This code was already used 3 times. The limit cannot be lower." }) }
        : { ok: true, json: async () => ({ codes: stored, redemptions: [] }) },
    );
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    await screen.findByText("SPRING25");
    const uses = document.querySelector("[data-attr='waive-codes-row-uses']") as HTMLInputElement;
    fireEvent.change(uses, { target: { value: "2" } });
    fireEvent.blur(uses);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("This code was already used 3 times. The limit cannot be lower."));
    expect((document.querySelector("[data-attr='waive-codes-row-uses']") as HTMLInputElement).value).toBe("20");
  });

  it("disabling asks first, then retires the code", async () => {
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    await screen.findByText("SPRING25");
    fireEvent.click(screen.getByRole("button", { name: "Disable code" }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0]!;
    expect(url).toBe("/api/manager/application-fee-waivers/c1");
    expect(JSON.parse(init.body as string)).toEqual({ action: "revoke" });
  });

  it("keeping a code cancels the disable", async () => {
    render(<WaiveCodesSettingsSection propertyOptions={PROPERTIES} />);
    await screen.findByText("SPRING25");
    fireEvent.click(screen.getByRole("button", { name: "Disable code" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep code" }));
    expect(screen.getByRole("button", { name: "Disable code" })).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });
});

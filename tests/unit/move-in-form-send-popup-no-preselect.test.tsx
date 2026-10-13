// @vitest-environment jsdom
/**
 * Forms + opens "Send a form" with nobody picked: no resident is chosen for the manager, no form or Due
 * row shows until they pick one, and from a resident's own record that one resident is still preset.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SendMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-send-popup";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/portal/forms",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/workspaces/selection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspaces/selection")>();
  return { ...actual, workspaceContainsProperty: () => true };
});
vi.mock("@/components/providers/app-ui-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/providers/app-ui-provider")>();
  return { ...actual, useAppUi: () => ({ showToast: vi.fn() }), useConfirm: () => vi.fn().mockResolvedValue(true) };
});
const inspections = vi.hoisted(() => ({ loadInspectionList: vi.fn() }));
vi.mock("@/lib/inspections/client", () => inspections);

const residency = (id: string, name: string) => ({
  id, name, property: "Brooklyn House", room: "Room 1", canCreate: true, propertyId: "p1", moveInDate: "2026-09-01", moveOutDate: "", occupancy: "current" as const,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Send a form popup", () => {
  it("is titled Send a form and picks no resident for the manager", async () => {
    inspections.loadInspectionList.mockResolvedValue({ residencies: [residency("a1", "Ada Lovelace"), residency("a2", "Zed Young")] });
    render(<SendMoveInFormPopup userId="u1" onClose={() => {}} />);
    expect(await screen.findByText("Choose a resident")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Send a form" })).toBeTruthy();
    expect(document.querySelector('[data-attr="move-in-form-send-form"]')).toBeNull();
    expect(document.querySelector('[data-attr="move-in-form-send-due"]')).toBeNull();
    expect((document.querySelector('[data-attr="move-in-form-send"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("from a resident record keeps that one resident chosen", async () => {
    inspections.loadInspectionList.mockResolvedValue({ residencies: [residency("a1", "Ada Lovelace"), residency("a2", "Zed Young")] });
    render(<SendMoveInFormPopup userId="u1" presetApplicationId="a2" onClose={() => {}} />);
    expect((await screen.findAllByText(/Zed Young/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Choose a resident")).toBeNull();
  });
});

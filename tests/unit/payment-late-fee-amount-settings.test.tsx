// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

const { showToast, persistOnServer, resolveHit } = vi.hoisted(() => ({
  showToast: vi.fn(),
  persistOnServer: vi.fn(async () => true),
  resolveHit: vi.fn(),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "manager@test.proplane.local", ready: true }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: persistOnServer,
  resolveManagerListingSubmissionForPropertyId: resolveHit,
}));

import { PaymentListingLateFeeSettings } from "@/components/portal/payment-late-fee-settings";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Payment settings late fee amount", () => {
  it("exposes amount, grace days, and applies-to on the payments settings panel", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"), "utf8");
    expect(src).toContain("PaymentListingLateFeeSettings");
    expect(src).toContain("Late fees");
    const compact = readFileSync(join(process.cwd(), "src/components/portal/payment-schedule-ui.tsx"), "utf8");
    expect(compact).not.toContain("Account-wide gate for automatic late fees");
  });

  it("writes lateFeeAmount and lateFeeGraceDays for the selected listing", async () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      lateFeeAmount: "50",
      lateFeeGraceDays: 5,
    });
    resolveHit.mockReturnValue({
      saveTarget: { mode: "listing", saveId: "house-1" },
      sub,
    });

    render(
      <PaymentListingLateFeeSettings
        propertyOptions={[{ id: "house-1", label: "5257 Brooklyn" }]}
        initialPropertyId="house-1"
      />,
    );

    const amount = await screen.findByLabelText("Late fee amount");
    await waitFor(() => expect((amount as HTMLInputElement).disabled).toBe(false));
    await userEvent.clear(amount);
    await userEvent.type(amount, "75");

    const grace = screen.getByLabelText("Grace days");
    await userEvent.click(screen.getByRole("button", { name: "Increase grace days" }));
    expect((grace as HTMLInputElement).value).toBe("6");

    await waitFor(
      () => {
        expect(persistOnServer).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    const [, , next] = persistOnServer.mock.calls.at(-1)!;
    expect(next).toMatchObject({ lateFeeAmount: "75", lateFeeGraceDays: 6 });
  });
});

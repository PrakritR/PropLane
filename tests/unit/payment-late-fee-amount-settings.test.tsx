// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { showToast, resolveHit } = vi.hoisted(() => ({
  showToast: vi.fn(),
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
  resolveManagerListingSubmissionForPropertyId: resolveHit,
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: vi.fn(async () => true),
}));

import { PaymentListingLateFeeSettings } from "@/components/portal/payment-late-fee-settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// No `SettingsPropertyScopeProvider` here on purpose — the account/no-scope
// case (a settings module rendered standalone) resolves the noop scope
// (`propertyIds: []`), which this component reads as "every property in
// `propertyOptions`" — with exactly one property passed in, that degenerates
// to the same single-listing write the old "Applies to" picker used to do.
describe("Payment settings late fee amount", () => {
  it("exposes amount and grace days on the payments settings panel", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-portal-settings-panels.tsx"), "utf8");
    expect(src).toContain("PaymentListingLateFeeSettings");
    expect(src).toContain("Late fees");
    const compact = readFileSync(join(process.cwd(), "src/components/portal/payment-schedule-ui.tsx"), "utf8");
    expect(compact).not.toContain("Account-wide gate for automatic late fees");
  });

  it("writes lateFeeAmount and lateFeeGraceDays for the sole property in scope", async () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      lateFeeAmount: "50",
      lateFeeGraceDays: 5,
    });
    resolveHit.mockReturnValue({
      saveTarget: { mode: "listing", saveId: "house-1" },
      sub,
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ listingsUpdated: 1 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PaymentListingLateFeeSettings propertyOptions={[{ id: "house-1", label: "5257 Brooklyn" }]} />);

    const amount = await screen.findByLabelText("Late fee amount");
    await waitFor(() => expect((amount as HTMLInputElement).disabled).toBe(false));
    await userEvent.clear(amount);
    await userEvent.type(amount, "75");

    const grace = screen.getByLabelText("Grace days");
    await userEvent.click(screen.getByRole("button", { name: "Increase grace days" }));
    expect((grace as HTMLInputElement).value).toBe("6");

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/portal/manager-listing-late-fee-settings");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ propertyIds: ["house-1"], lateFeeAmount: "75", lateFeeGraceDays: 6 });
  });

  it("does not retry a failed save until the manager edits again", async () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      lateFeeAmount: "50",
      lateFeeGraceDays: 5,
    });
    resolveHit.mockReturnValue({
      saveTarget: { mode: "listing", saveId: "house-1" },
      sub,
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Could not save late fee." }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PaymentListingLateFeeSettings propertyOptions={[{ id: "house-1", label: "5257 Brooklyn" }]} />);

    const amount = await screen.findByLabelText("Late fee amount");
    await waitFor(() => expect((amount as HTMLInputElement).disabled).toBe(false));
    await userEvent.clear(amount);
    await userEvent.type(amount, "75");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ listingsUpdated: 1 }), { status: 200 }),
    );
    await userEvent.type(amount, "0");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ lateFeeAmount: "750" });
  });
});

// @vitest-environment jsdom
//
// PLAN-0920-0845 phase E — the Late fees section of Payments settings is
// driven entirely by the module's own scope bar
// (`useSettingsPropertyScope()`), never an internal "Applies to" picker.
// Late fee amount + grace days live on each LISTING (no workspace/account
// rung), so:
//   - picked properties  -> the write fans out to exactly those listings
//   - no pick            -> "all properties in <workspace>" fans out to
//                           every listing `propertyOptions` names
//   - an empty workspace -> the reason renders as the field's value, inputs
//                           disabled, no write is possible
//   - a rejected id       -> the whole batch write is refused, nothing saved
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

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
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";

function submissionFor(amount: string, graceDays: number) {
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    lateFeeAmount: amount,
    lateFeeGraceDays: graceDays,
  });
}

function renderWithScope(opts: {
  propertyIds: string[];
  propertyOptions: { id: string; label: string }[];
  workspaceName?: string;
  workspaceId?: string;
}) {
  return render(
    <SettingsPropertyScopeProvider
      workspaceIds={[opts.workspaceId ?? "ws-33"]}
      onWorkspaceIdsChange={() => {}}
      propertyIds={opts.propertyIds}
      onPropertyIdsChange={() => {}}
      options={opts.propertyOptions}
    >
      <PaymentListingLateFeeSettings
        propertyOptions={opts.propertyOptions}
        workspaceName={opts.workspaceName}
        workspaceId={opts.workspaceId}
      />
    </SettingsPropertyScopeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Late fees follow the settings scope bar", () => {
  it("picked properties write exactly those listings", async () => {
    resolveHit.mockReturnValue({ saveTarget: { mode: "listing", saveId: "a" }, sub: submissionFor("50", 5) });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ listingsUpdated: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderWithScope({
      propertyIds: ["prop-a", "prop-b"],
      propertyOptions: [
        { id: "prop-a", label: "House A" },
        { id: "prop-b", label: "House B" },
        { id: "prop-c", label: "House C" },
      ],
      workspaceName: "33",
    });

    const amount = await screen.findByLabelText("Late fee amount");
    await waitFor(() => expect((amount as HTMLInputElement).disabled).toBe(false));
    await userEvent.clear(amount);
    await userEvent.type(amount, "75");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse((init as RequestInit).body as string);
    // Only the two EXPLICITLY selected properties — not the third one that
    // exists in the workspace but was not picked.
    expect(body.propertyIds.sort()).toEqual(["prop-a", "prop-b"]);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Late fee $75 saved on 2 properties."));
  });

  it('"all properties in <workspace>" fans the write out to every listing and toasts the workspace name', async () => {
    resolveHit.mockReturnValue({ saveTarget: { mode: "listing", saveId: "p1" }, sub: submissionFor("50", 5) });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ listingsUpdated: 6 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const propertyOptions = Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}`, label: `House ${i + 1}` }));
    renderWithScope({ propertyIds: [], propertyOptions, workspaceName: "33", workspaceId: "ws-33" });

    const amount = await screen.findByLabelText("Late fee amount");
    await waitFor(() => expect((amount as HTMLInputElement).disabled).toBe(false));
    await userEvent.clear(amount);
    await userEvent.type(amount, "75");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.propertyIds.sort()).toEqual(propertyOptions.map((o) => o.id).sort());
    expect(body.workspaceId).toBe("ws-33");

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Late fee $75 saved on 6 properties in 33"),
    );
  });

  it("an empty workspace shows the reason as the field's value and disables the inputs", async () => {
    renderWithScope({ propertyIds: [], propertyOptions: [], workspaceName: "Empty Co", workspaceId: "ws-empty" });

    const reason = await screen.findByText("No properties in this workspace yet");
    expect(reason).toBeInTheDocument();
    expect(screen.queryByLabelText("Late fee amount")).not.toBeInTheDocument();

    const grace = screen.getByLabelText("Grace days");
    expect((grace as HTMLInputElement).disabled).toBe(true);
  });

  it("rejects the whole write when one of the picked properties is not authorized", async () => {
    resolveHit.mockReturnValue({ saveTarget: { mode: "listing", saveId: "a" }, sub: submissionFor("50", 5) });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "That property is not in your workspace." }), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithScope({
      propertyIds: ["prop-a", "prop-not-mine"],
      propertyOptions: [
        { id: "prop-a", label: "House A" },
        { id: "prop-not-mine", label: "Not mine" },
      ],
    });

    const amount = await screen.findByLabelText("Late fee amount");
    await waitFor(() => expect((amount as HTMLInputElement).disabled).toBe(false));
    await userEvent.clear(amount);
    await userEvent.type(amount, "75");

    // One call, one refusal — the server never gets to writing the first id
    // before the whole batch fails, and nothing here claims a partial save.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("That property is not in your workspace."));
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining("saved"));
  });
});

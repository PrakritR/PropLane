/** @vitest-environment jsdom */
/**
 * A promo code lives on ONE property.
 *
 * The codes table is unique on (manager, code text), so the same code cannot
 * sit on two listings. The Applications panel nevertheless offered a
 * multi-property selection, promised "any of the N selected properties", and
 * replayed the field's value on every PATCH — including automation-only saves.
 * Selecting three houses and typing a code wrote it to the first, 400'd on the
 * second ("already in use on another property"), and broke the loop; the same
 * replay meant an ordinary auto-approve toggle stopped saving partway down the
 * selection for a manager who had ever set a code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));

import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";

const PROPERTY_OPTIONS = [
  { id: "prop-1", label: "Ballard House" },
  { id: "prop-2", label: "Fremont Flat" },
  { id: "prop-3", label: "Queen Anne Loft" },
];

let patches: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("manager-application-settings") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ automation: { autoApproveApplications: false }, waiverCode: "WELCOME50" }),
          { status: 200 },
        );
      }
      if (url.includes("manager-application-settings") && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModal() {
  return render(
    <ProPortalSettingsModal
      open
      onClose={() => undefined}
      initialTab="applications"
      propertyOptions={PROPERTY_OPTIONS}
    />,
  );
}

async function selectEveryProperty() {
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.click(await screen.findByText(/select all/i));
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
}

function promoField(): HTMLInputElement {
  return screen.getByLabelText(/promo code/i) as HTMLInputElement;
}

describe("promo code with several properties selected", () => {
  it("sends nothing at all, rather than half-writing the selection", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).not.toBeDisabled());
    await selectEveryProperty();

    await waitFor(() => expect(promoField()).toBeDisabled());
    patches.length = 0;
    // Blur is the commit gesture; with no single property it must be inert.
    fireEvent.focus(promoField());
    fireEvent.blur(promoField());
    await act(async () => {
      await Promise.resolve();
    });

    expect(patches).toHaveLength(0);
  });

  it("says the code belongs to one property instead of promising all of them", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    await selectEveryProperty();

    expect(await screen.findByText(/a promo code belongs to one property/i)).toBeInTheDocument();
    expect(screen.queryByText(/any of the 3 selected properties/i)).toBeNull();
  });
});

describe("promo code with exactly one property selected", () => {
  it("writes the code for that property and nothing else", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    patches.length = 0;

    await userEvent.clear(promoField());
    await userEvent.type(promoField(), "SPRING10");
    fireEvent.blur(promoField());

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ propertyId: "prop-1", waiverCode: "SPRING10" });
    // The waiver write must not smuggle an automation save along with it.
    expect(patches[0]).not.toHaveProperty("automation");
  });
});

describe("automation toggles across several properties", () => {
  it("saves every selected property and never replays the promo code", async () => {
    renderModal();
    await waitFor(() => expect(promoField()).toHaveValue("WELCOME50"));
    await selectEveryProperty();
    patches.length = 0;

    await userEvent.click(await screen.findByRole("checkbox", { name: /auto-approve applications/i }));

    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches.map((p) => p.propertyId)).toEqual(["prop-1", "prop-2", "prop-3"]);
    for (const patch of patches) {
      expect(patch).toHaveProperty("automation");
      expect(patch).not.toHaveProperty("waiverCode");
    }
  });
});

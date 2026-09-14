// @vitest-environment jsdom
/**
 * Regression for the shared-channels defect: `ReminderAudienceChannelCells`
 * used to be rendered once per audience row (You / Team / Resident), all
 * three bound to the same `rule.email` / `rule.sms` state — so clicking
 * "You → Text" silently also flipped "Resident → Text" because there was
 * never more than one value to begin with. The channels are per-RULE, not
 * per-audience (`rules.ts`), so the control must render exactly once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { ManagerReminderRuleSettingsPanel } from "@/components/portal/manager-reminder-rule-settings";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/reminder-settings")) {
        if (init?.method === "PATCH") return Response.json({ settings: {} });
        return Response.json({ settings: {} });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

const teamMembers = [{ userId: "u1" }, { userId: "u2" }];

function renderPanel() {
  return render(
    <ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={teamMembers} />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ManagerReminderRuleSettingsPanel channels are rule-wide", () => {
  it("renders the channel controls once for the rule, not once per audience row", async () => {
    stubFetch();
    renderPanel();

    // All three audience rows are live for this kind/mode — confirm they are
    // actually on screen before asserting the channel group is not duplicated
    // alongside them.
    await screen.findByText("You");
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.getByText("Resident & vendor")).toBeTruthy();

    expect(screen.getAllByRole("group", { name: "Delivery channels" })).toHaveLength(1);
    expect(screen.getAllByRole("switch", { name: "Inbox" })).toHaveLength(1);
    expect(screen.getAllByRole("switch", { name: "Email" })).toHaveLength(1);
    expect(screen.getAllByRole("switch", { name: "Text" })).toHaveLength(1);

    // The shared row sits under its own "Send via" label, not nested inside
    // any of the three "Notify" audience rows.
    expect(screen.getByText("Send via")).toBeTruthy();
  });

  it("toggling the shared channel changes the rule's single value and no second control claims a different state", async () => {
    stubFetch();
    renderPanel();

    const textCell = await screen.findByRole("switch", { name: "Text" });
    expect(textCell.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(textCell);

    // Still exactly one Text control, and it reflects the new value — there is
    // no second, stale control left showing the old state.
    const textCellsAfter = screen.getAllByRole("switch", { name: "Text" });
    expect(textCellsAfter).toHaveLength(1);
    expect(textCellsAfter[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("never lets the inbox channel be switched off", async () => {
    stubFetch();
    renderPanel();

    const inboxCell = await screen.findByRole("switch", { name: "Inbox" });
    expect(inboxCell.getAttribute("aria-checked")).toBe("true");
    expect(inboxCell).toBeDisabled();

    await userEvent.click(inboxCell);
    expect(inboxCell.getAttribute("aria-checked")).toBe("true");
  });
});

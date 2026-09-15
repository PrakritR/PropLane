// @vitest-environment jsdom
/**
 * Covers the Part 2 redraw of `ManagerReminderRuleSettingsPanel`: audience
 * rows are always visible (no mode selector hiding them first), an audience
 * a kind cannot notify renders locked with a real reason rather than
 * silently missing, `tour_interest`'s dispatcher-fixed fields render locked
 * with the declared reason, and the inbox channel can never be switched off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fixedRuleFields } from "@/lib/reminders/fixed-rule-fields";

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ManagerReminderRuleSettingsPanel audience rows", () => {
  it("shows every supported audience row without first choosing a mode", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    // Both "You" and "Resident" (audienceMode="both") are visible immediately —
    // no "Reminder type" mode picker to click through first. The assigned vendor
    // rides with Team, so the counterparty row is the resident alone.
    expect(await screen.findByText("You")).toBeTruthy();
    expect(screen.getByText("Resident")).toBeTruthy();
    expect(screen.queryByText(/reminder type/i)).toBeNull();
  });

  it("locks an audience a kind cannot notify, with a real reason, instead of hiding the row", async () => {
    stubFetch();
    render(
      <ManagerReminderRuleSettingsPanel
        kind="inspection_manager"
        audienceMode="manager"
        teamMembers={[{ userId: "u1" }, { userId: "u2" }]}
      />,
    );

    // "Resident" (the counterparty) is not supported for inspection_manager — it must still
    // render, locked, with a real explanation, never silently absent.
    const lockedLabel = await screen.findByText("Resident");
    const lockedRow = lockedLabel.closest("div");
    expect(lockedRow?.textContent).toMatch(/never notified/i);

    // Manager and team ARE supported for this kind and must render as live controls.
    expect(screen.getByRole("switch", { name: "Notify You" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notify Team" })).toBeTruthy();
  });

  it("locks the team audience with a reason when there are no co-managers to notify", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    const teamLabel = await screen.findByText("Team");
    expect(teamLabel.closest("div")?.textContent).toMatch(/co-manager/i);
  });

  it("renders tour_interest's dispatcher-fixed fields locked, carrying the declared reason", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="tour_interest" audienceMode="counterparty" teamMembers={[]} />);

    const fixed = fixedRuleFields("tour_interest");
    expect(fixed).not.toBeNull();

    // tour_interest ships disabled by default — turn the rule on so its (fixed)
    // timing/audience/channel rows render at all, same as the pre-existing gate.
    await userEvent.click(await screen.findByRole("switch", { name: "Send reminders" }));

    const matches = await screen.findAllByText(fixed!.reason);
    // timings, audience ("Who's notified"), and channels are all fixed for this kind —
    // each renders its own locked row carrying the same declared reason.
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("never lets the inbox channel be switched off", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    await screen.findByText("You");
    // Send via is one dropdown for the rule; Inbox is ticked and cannot be unticked.
    fireEvent.click(screen.getByRole("button", { name: "Send via", expanded: false }));
    const listbox = screen.getByRole("listbox", { name: "Send via" });
    const inbox = within(listbox).getByRole("option", { name: "Inbox" });
    expect(inbox.getAttribute("aria-selected")).toBe("true");
    expect(inbox.getAttribute("aria-disabled")).toBe("true");

    // A disabled option ignores the pick, but assert the state explicitly rather than
    // just trusting `aria-disabled` — this is the guarantee the control exists to make.
    fireEvent.pointerDown(inbox, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(inbox, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(within(listbox).getByRole("option", { name: "Inbox" }).getAttribute("aria-selected")).toBe("true");
  });

  it("gives every settings row a label and a control, never a sentence under it", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    const youLabel = await screen.findByText("You");
    // The label's own column holds nothing but the label (AGENTS.md § No subtext).
    expect(youLabel.parentElement?.textContent).toBe("You");
    expect(screen.queryByText(/through the channels set below/i)).toBeNull();
    expect(screen.queryByText(/Turns this reminder on or off/i)).toBeNull();
    expect(screen.queryByText(/Applies to everyone notified above/i)).toBeNull();
  });
});

// @vitest-environment jsdom
//
// Every conversation surface shares the manager Communication reply row:
// the field, then ✦ AI and the channel menu beside Send — never the old
// segmented Email · Text control with "Add an email address" above the field,
// and never a separate "Ask PropLane" pill.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: (msg: string) => showToast(msg) }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({ ManagerSmsComposeModal: () => null }));

import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";

const PAYLOAD = {
  workNumber: "+12065550999",
  personalPhone: null,
  phoneVerified: false,
  forwardInbound: true,
  smsConfigured: true,
  residents: [
    {
      residentUserId: null,
      residentEmail: null,
      name: null,
      phone: "+15107596062",
      propertyLabel: null,
      tenancyStatus: "prospect" as const,
      counterpartyRole: "prospect" as const,
      conversationKey: "mgr-1:phone:+15107596062",
      ownerManagerUserId: "mgr-1",
      messages: [
        {
          id: "m1",
          direction: "inbound" as const,
          body: "What's 300+900",
          fromPhone: "+15107596062",
          toPhone: "+12065550999",
          messageSid: "SM1",
          source: "work_number" as const,
          createdAt: "2026-09-12T19:00:00.000Z",
          storageTable: "inbound_sms_log" as const,
        },
      ],
    },
  ],
};

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SMS conversations use the Communication reply row", () => {
  it("shows ✦ AI and the channel menu beside the field, and no picker or pill above it", async () => {
    render(<ManagerSmsPanel />);
    await waitFor(() => expect(screen.getByText("+1 (510) 759-6062")).toBeTruthy());
    screen.getByText("+1 (510) 759-6062").click();
    await waitFor(() => expect(document.querySelector('[data-attr="sms-messages-reply"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="inbox-composer-ai-menu"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="inbox-reply-send-via"]')).not.toBeNull();
    expect(screen.queryByText("Add an email address")).toBeNull();
    expect([...document.querySelectorAll("button")].some((b) => /^Ask PropLane$/.test(b.textContent?.trim() ?? ""))).toBe(false);
  });
});

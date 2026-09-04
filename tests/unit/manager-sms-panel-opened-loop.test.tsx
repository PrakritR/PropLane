// @vitest-environment jsdom
//
// Regression: the unified Communication inbox drives `ManagerSmsPanel` in
// controlled mode (`controlledActiveId` from the list pane) and passes an
// INLINE `onConversationOpened` callback that changes identity on every parent
// render. The controlled-open effect used to depend on both that callback and
// `rows`, so opening a thread fired `onConversationOpened` → parent refetched
// SMS → new `rows` + new callback identity → the effect re-ran → refetched
// again … an unbounded loop ("Maximum update depth exceeded") that left the
// thread highlighted in the list but the reading pane stuck on "Select a
// conversation".
//
// The fix keeps the latest callback in a ref (out of the deps) and guards on a
// `lastSyncedControlledIdRef`, so the sync fires exactly once per real
// selection change — never on callback identity churn or `rows` refetches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({
  ManagerSmsComposeModal: () => null,
}));

import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";

const ROW_ID = "mgr-1:resident:res-1";

const PAYLOAD = {
  workNumber: "+12065550999",
  personalPhone: null,
  phoneVerified: false,
  forwardInbound: true,
  smsConfigured: true,
  residents: [
    {
      residentUserId: "res-1",
      residentEmail: "jane@example.com",
      name: "Jane Resident",
      phone: "+12065550100",
      propertyLabel: "Unit A",
      tenancyStatus: "resident" as const,
      counterpartyRole: "resident" as const,
      conversationKey: ROW_ID,
      ownerManagerUserId: "mgr-1",
      messages: [
        {
          id: "m1",
          direction: "inbound" as const,
          body: "hi it's Jane",
          fromPhone: "+12065550100",
          toPhone: "+12065550999",
          messageSid: "SM1",
          source: "work_number" as const,
          createdAt: "2026-07-20T00:00:00.000Z",
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
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagerSmsPanel controlled-open sync", () => {
  it("fires onConversationOpened exactly once per controlled selection, even as the callback identity churns", async () => {
    let opened = 0;
    // A fresh inline callback each render — exactly what the unified inbox parent
    // passed before it was stabilized. The buggy effect re-fired on every one.
    const renderPanel = () =>
      render(
        <ManagerSmsPanel
          suppressListPane
          controlledActiveId={ROW_ID}
          onConversationOpened={() => {
            opened += 1;
          }}
        />,
      );

    const { rerender } = renderPanel();

    // Once rows load, the controlled selection is synced exactly once.
    await waitFor(() => expect(opened).toBe(1));

    // Simulate several parent re-renders, each handing down a brand-new callback
    // identity (and re-running the panel). The sync must NOT fire again for the
    // same controlledActiveId.
    for (let i = 0; i < 5; i++) {
      rerender(
        <ManagerSmsPanel
          suppressListPane
          controlledActiveId={ROW_ID}
          onConversationOpened={() => {
            opened += 1;
          }}
        />,
      );
    }

    // Give any runaway effect a chance to fire before asserting stability.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toBe(1);
  });

  it("re-syncs when the controlled selection actually changes", async () => {
    let opened = 0;
    const twoRowPayload = {
      ...PAYLOAD,
      residents: [
        PAYLOAD.residents[0],
        {
          ...PAYLOAD.residents[0],
          residentUserId: "res-2",
          residentEmail: "sam@example.com",
          name: "Sam Resident",
          phone: "+12065550200",
          conversationKey: "mgr-1:resident:res-2",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(twoRowPayload), { status: 200 })),
    );

    const { rerender } = render(
      <ManagerSmsPanel
        suppressListPane
        controlledActiveId={ROW_ID}
        onConversationOpened={() => {
          opened += 1;
        }}
      />,
    );
    await waitFor(() => expect(opened).toBe(1));

    rerender(
      <ManagerSmsPanel
        suppressListPane
        controlledActiveId="mgr-1:resident:res-2"
        onConversationOpened={() => {
          opened += 1;
        }}
      />,
    );
    await waitFor(() => expect(opened).toBe(2));
  });
});

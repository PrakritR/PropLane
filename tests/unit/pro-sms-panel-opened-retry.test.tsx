// @vitest-environment jsdom
//
// The standalone ManagerSmsPanel owns the controlled SMS-open callback used by
// admin Communication and by the unified pane. A failed localStorage write is
// a volatile receipt only: an explicit mounted reopen must reach the shared
// helper again and preserve unrelated durable receipts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "manager-1", email: "manager@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({
  ManagerSmsComposeModal: () => null,
}));

import { loadManagerSmsOpenedIds } from "@/lib/manager-sms-opened.client";
import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";

const OPENED_KEY = "axis_manager_sms_opened_v2:manager-1";
const ALICE_ID = "mgr-1:resident:alice";
const BOB_ID = "mgr-1:resident:bob";

const PAYLOAD = {
  workNumber: "+12065550999",
  personalPhone: null,
  phoneVerified: false,
  forwardInbound: true,
  smsConfigured: true,
  residents: [
    {
      residentUserId: "alice",
      residentEmail: "alice@example.com",
      name: "Alice Resident",
      phone: "+12065550100",
      propertyLabel: "Unit A",
      tenancyStatus: "resident" as const,
      counterpartyRole: "resident" as const,
      conversationKey: ALICE_ID,
      ownerManagerUserId: "manager-1",
      messages: [
        {
          id: "sms-alice-1",
          direction: "inbound" as const,
          body: "Alice inbound",
          fromPhone: "+12065550100",
          toPhone: "+12065550999",
          messageSid: "SM-ALICE-1",
          source: "work_number" as const,
          createdAt: "2026-09-13T18:00:00.000Z",
          storageTable: "inbound_sms_log" as const,
        },
      ],
    },
    {
      residentUserId: "bob",
      residentEmail: "bob@example.com",
      name: "Bob Resident",
      phone: "+12065550200",
      propertyLabel: "Unit B",
      tenancyStatus: "resident" as const,
      counterpartyRole: "resident" as const,
      conversationKey: BOB_ID,
      ownerManagerUserId: "manager-1",
      messages: [
        {
          id: "sms-bob-1",
          direction: "inbound" as const,
          body: "Bob inbound",
          fromPhone: "+12065550200",
          toPhone: "+12065550999",
          messageSid: "SM-BOB-1",
          source: "work_number" as const,
          createdAt: "2026-09-13T18:01:00.000Z",
          storageTable: "inbound_sms_log" as const,
        },
      ],
    },
  ],
};

type TestStorage = {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>;
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
  removeItem: ReturnType<typeof vi.fn<(key: string) => void>>;
};

let storage: TestStorage;
let failWrites = false;

beforeEach(() => {
  vi.clearAllMocks();
  failWrites = false;
  const values = new Map<string, string>();
  storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      if (failWrites) throw new Error("storage denied");
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })),
  );
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagerSmsPanel durable opened receipts", () => {
  it("reauthorizes an unchanged selected projection on a quiet poll and removes a revoked transcript", async () => {
    const resident = {
      ...PAYLOAD.residents[0],
      projectionId: "projection-alice",
      unread: false,
      stateVersion: 1,
      messages: [{ ...PAYLOAD.residents[0].messages[0], id: "preview", body: "Public preview" }],
    };
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/manager/sms-conversations/projection-alice")) {
        detailReads += 1;
        return detailReads === 1
          ? Response.json({ resident, messages: [{ ...resident.messages[0], id: "private", body: "Private transcript" }], nextCursor: null })
          : Response.json({ error: "Conversation unavailable" }, { status: 403 });
      }
      return Response.json({ ...PAYLOAD, residents: [resident] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerSmsPanel />);
    await waitFor(() => expect(screen.getByText("Alice Resident")).toBeTruthy());
    fireEvent.click(screen.getByText("Alice Resident"));
    await waitFor(() => expect(screen.getByText("Private transcript")).toBeTruthy());

    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(detailReads).toBe(2));
    await waitFor(() => expect(screen.queryByText("Private transcript")).toBeNull());
    expect(screen.queryByText("Alice Resident")).toBeNull();
  });

  it("retries a failed mounted receipt on A/B/A and survives remount without dropping unrelated IDs", async () => {
    storage.setItem(OPENED_KEY, JSON.stringify(["unrelated-opened-id"]));
    storage.setItem.mockClear();
    failWrites = true;

    render(<ManagerSmsPanel />);
    await waitFor(() => expect(screen.getByText("Alice Resident")).toBeTruthy());

    fireEvent.click(screen.getByText("Alice Resident"));
    await waitFor(() => expect(screen.getAllByText("Alice inbound").length).toBeGreaterThan(1));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);

    // A second explicit selection while storage remains unavailable is bounded
    // to that interaction. It must not turn the failed receipt into a render
    // loop or duplicate a network/provider action.
    fireEvent.click(screen.getByText("Bob Resident"));
    await waitFor(() => expect(screen.getAllByText("Bob inbound").length).toBeGreaterThan(1));
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledTimes(2);

    // Storage recovers while this same panel remains mounted. Reopening A must
    // call the real helper despite A's volatile in-memory membership.
    failWrites = false;
    fireEvent.click(screen.getByText("Alice Resident"));
    await waitFor(() => expect(screen.getAllByText("Alice inbound").length).toBeGreaterThan(1));
    expect(storage.setItem).toHaveBeenCalledTimes(3);
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.getItem(OPENED_KEY) ?? "[]")).toEqual([
      "unrelated-opened-id",
      "sms-alice-1",
    ]);
    expect(JSON.parse(storage.getItem(OPENED_KEY) ?? "[]")).not.toContain("sms-bob-1");

    // A remount reads durable state through the same helper. Opening A again
    // is a no-op write because its receipt is now genuinely persisted.
    cleanup();
    render(<ManagerSmsPanel />);
    await waitFor(() => expect(screen.getByText("Alice Resident")).toBeTruthy());
    expect(loadManagerSmsOpenedIds("manager-1")).toEqual(
      new Set(["unrelated-opened-id", "sms-alice-1"]),
    );
    fireEvent.click(screen.getByText("Alice Resident"));
    await waitFor(() => expect(screen.getAllByText("Alice inbound").length).toBeGreaterThan(1));
    expect(storage.setItem).toHaveBeenCalledTimes(3);
  });

  it("defers a hidden controlled receipt and stores it once when the pane becomes visible", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    render(
      <ManagerSmsPanel
        suppressListPane
        controlledActiveId={ALICE_ID}
      />,
    );
    await waitFor(() => expect(screen.getByText("Alice inbound")).toBeTruthy());
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(loadManagerSmsOpenedIds("manager-1")).toEqual(new Set());

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(loadManagerSmsOpenedIds("manager-1")).toEqual(new Set(["sms-alice-1"])));
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    // Repeated visibility notifications and row churn must not reopen an
    // already-synchronized controlled selection.
    fireEvent(document, new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});

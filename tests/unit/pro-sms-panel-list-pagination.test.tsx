// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { ManagerSmsPanel, type ManagerSmsPanelHandle } from "@/components/portal/pro-sms-panel";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "manager-1", ready: true }) }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true), useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({ ManagerSmsComposeModal: () => null }));

const row = (id: number | string): ManagerSmsResidentConversation => ({
  projectionId: `projection-${id}`, conversationKey: null, name: `Person ${id}`,
  ownerManagerUserId: "manager-1", counterpartyRole: "prospect", phone: `+1206555${String(id).padStart(4, "0")}`,
  messages: [{ id: `message-${id}`, direction: "inbound", body: `BODY ${id}`,
    fromPhone: "+12065550100", toPhone: "+12065550999", createdAt: "2026-09-26T10:00:00Z", source: "work_number" }],
} as ManagerSmsResidentConversation);
const page = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => row(start + index));
const payload = (residents: ManagerSmsResidentConversation[], nextCursor: string | null) => ({
  workNumber: "+12065550999", personalPhone: null, phoneVerified: false,
  forwardInbound: true, smsConfigured: true, residents, nextCursor,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SMS panel conversation pagination", () => {
  it("reaches missing middle conversations after an old row moves into the fresh head", async () => {
    const ref = createRef<ManagerSmsPanelHandle>();
    const seen: string[] = [];
    let refreshed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("before=fresh-boundary")) return Response.json(payload([row(42), row(41)], null));
      if (refreshed) return Response.json(payload([row(1), ...page(43, 81)], "fresh-boundary"));
      return Response.json(payload(page(1, 40), null));
    }));
    render(<ManagerSmsPanel ref={ref} />);
    await screen.findByText("Person 40");
    expect(screen.queryByText("Load more conversations")).toBeNull();
    refreshed = true;
    await act(async () => ref.current?.reload());
    await screen.findByText("Person 81");
    expect(screen.queryByText("Person 40")).toBeNull();
    expect(screen.getByText("Person 1")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more conversations"));
    await screen.findByText("Person 41");
    expect(screen.getByText("Person 42")).toBeTruthy();
    expect(seen).toEqual(["/api/manager/sms-conversations", "/api/manager/sms-conversations", "/api/manager/sms-conversations?before=fresh-boundary"]);
  });

  it("ignores a stale appended page and keeps the fresh continuation", async () => {
    const ref = createRef<ManagerSmsPanelHandle>();
    const stale = deferred<Response>();
    const seen: string[] = [];
    let refreshed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("before=old-boundary")) return stale.promise;
      if (url.includes("before=fresh-boundary")) return Response.json(payload([row(41)], null));
      return refreshed
        ? Response.json(payload([row(1), row(81)], "fresh-boundary"))
        : Response.json(payload([row(1)], "old-boundary"));
    }));
    render(<ManagerSmsPanel ref={ref} />);
    fireEvent.click(await screen.findByText("Load more conversations"));
    await waitFor(() => expect(seen).toContain("/api/manager/sms-conversations?before=old-boundary"));
    refreshed = true;
    await act(async () => ref.current?.reload());
    await screen.findByText("Person 81");
    await act(async () => stale.resolve(Response.json(payload([row("stale")], null))));
    expect(screen.queryByText("Person stale")).toBeNull();
    fireEvent.click(screen.getByText("Load more conversations"));
    await screen.findByText("Person 41");
    expect(seen.at(-1)).toBe("/api/manager/sms-conversations?before=fresh-boundary");
  });
});

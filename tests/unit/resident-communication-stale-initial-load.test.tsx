// @vitest-environment jsdom
//
// Regression: /resident/communication/active stayed on "Loading conversations…" forever.
//
// The resident page is server-rendered with the user id, so its first inbox request starts before the
// browser session store has published that same id. When the store then resolves, it purges the inbox
// caches and the in-flight request is (correctly) discarded as `stale`. `loadInitialList` used to
// `return` on stale and nothing re-ran it, because the component's own viewer id never changed.
// These tests use the REAL storage module and a held fetch, so they fail if a stale answer ever
// strands the list again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const ROW = {
  id: "res-thr-2000000001",
  folder: "inbox",
  from: "Dana Whitfield",
  email: "dana@example.com",
  subject: "Welcome home",
  preview: "Keys are ready",
  body: "Keys are ready",
  time: "Jul 20, 2026",
  unread: false,
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/communication/active",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
// The server handed the page the user id, so the hook reports ready immediately.
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "resident-1", email: "resident@example.com", ready: true }),
}));
vi.mock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
vi.mock("@/components/portal/resident-inbox-panel", () => ({
  ResidentInboxPanel: () => <div data-testid="resident-thread" />,
}));
vi.mock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div /> }));

type Held = { resolve: (res: Response) => void };

describe("resident Communication initial load vs. a viewer change mid-request", () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function mountWithHeldInbox() {
    const session = await import("@/lib/auth/portal-session-gate");
    session.markPortalSessionActive();
    const held: Held[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/portal-inbox-threads")) {
          return new Promise<Response>((resolve) => held.push({ resolve }));
        }
        return Promise.resolve(Response.json({}));
      }),
    );
    const { ResidentCommunication } = await import("@/components/portal/resident-communication");
    render(<ResidentCommunication residentUserId="resident-1" />);
    await waitFor(() => expect(held.length).toBe(1));
    return { session, held };
  }

  it("leaves the skeleton and lists the conversation when the session store resolves mid-request", async () => {
    const { session, held } = await mountWithHeldInbox();
    // Still the anonymous cache slot: nothing is ready yet.
    expect(screen.getByText("Loading conversations…")).toBeTruthy();

    // The browser session store publishes the viewer: caches purge, the held request is now stale.
    await act(async () => {
      session.setPortalSessionViewer("resident-1");
    });
    await act(async () => {
      held[0]!.resolve(Response.json({ rows: [ROW] }));
    });

    // The load asked again for the current viewer; answer that request.
    await waitFor(() => expect(held.length).toBe(2));
    await act(async () => {
      held[1]!.resolve(Response.json({ rows: [ROW] }));
    });

    await waitFor(() => expect(screen.getByText("Dana Whitfield")).toBeTruthy());
    expect(screen.queryByText("Loading conversations…")).toBeNull();
  });

  it("never strands the skeleton: persistent staleness ends in the error state", async () => {
    const { session, held } = await mountWithHeldInbox();
    await act(async () => {
      session.setPortalSessionViewer("resident-1");
    });
    // Every retry is invalidated again by another viewer flip while it is in flight.
    const flip = ["resident-2", "resident-1", "resident-2"];
    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => expect(held.length).toBe(i + 1));
      await act(async () => {
        session.setPortalSessionViewer(flip[i]!);
      });
      await act(async () => {
        held[i]!.resolve(Response.json({ rows: [ROW] }));
      });
    }
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull());
  });
});

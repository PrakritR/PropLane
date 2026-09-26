// @vitest-environment jsdom
//
// Regression: archiving a resident-directory placeholder (no stored
// conversation at all) must persist a real, already-archived thread for that
// contact — through the SAME authorized upsert path every other thread
// mutation uses (no new table/column/route) — so it is gone from Active and
// present in Archived even after a full reload (a fresh fetch of the
// server's own rows, not just the optimistic local write).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

const CONTACT: InboxScopedContact = {
  id: "res-atlas-1",
  name: "Atlas Sebastien Bailly",
  email: "atlas@example.test",
  role: "resident",
  tenancyStatus: "resident",
};

describe("archiving a resident placeholder", () => {
  let serverRows: PersistedInboxThread[];

  beforeEach(() => {
    serverRows = [];
    vi.resetModules();
    vi.doMock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
    vi.doMock("@/hooks/use-portal-session", () => ({
      usePortalSession: () => ({ userId: "viewer-ui", email: "viewer@example.com", ready: true }),
    }));
    vi.doMock("@/components/providers/app-ui-provider", () => ({
      useOptionalAppUi: () => null,
      useConfirm: () => async () => true,
    }));
    vi.doMock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
    vi.doMock("@/components/portal/pro-inbox", () => ({
      ManagerInbox: () => <div data-testid="embedded-email-thread" />,
    }));
    vi.doMock("@/components/portal/pro-sms-panel", () => ({
      ManagerSmsPanel: () => <div data-testid="embedded-sms-thread" />,
      smsOutboundPreviewPrefix: () => "",
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    // Real memory/session commit + PORTAL_INBOX_CHANGED_EVENT dispatch stay
    // wired up (via `stagePersistedInboxRows`, kept real below) — only the
    // two functions that would otherwise hit a real network are replaced
    // with a controllable in-memory "server".
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/portal-inbox-storage")>();
      return {
        ...actual,
        syncPersistedInboxFromServerWithStatus: async () => ({ rows: structuredClone(serverRows), ok: true }),
        upsertPersistedInboxRows: async (
          key: string,
          changedRows: PersistedInboxThread[],
          allRows: PersistedInboxThread[],
        ) => {
          actual.stagePersistedInboxRows(key, allRows);
          for (const row of changedRows) {
            const idx = serverRows.findIndex((r) => r.id === row.id);
            if (idx >= 0) serverRows[idx] = { ...serverRows[idx], ...row };
            else serverRows.push({ ...row });
          }
          return true;
        },
      };
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/manager/sms-conversations")
        ? { residents: [], nextCursor: null }
        : {},
    ), { status: 200 })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("moves the placeholder to a real archived thread that survives a full reload", async () => {
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const first = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        filterContacts={[CONTACT]}
      />,
    );
    await waitFor(() => expect(within(document.querySelector('[data-communication-inbox-list]') as HTMLElement)
      .getAllByText("Atlas Sebastien Bailly").length).toBeGreaterThan(0), { timeout: 10000 });

    const { archivePlaceholderContactThread } = await import("@/lib/communication-inbox-thread-mutations");
    await act(async () => {
      const result = await archivePlaceholderContactThread("axis_portal_inbox_manager_v1", {
        id: CONTACT.id,
        email: CONTACT.email,
        name: CONTACT.name,
      });
      expect(result.ok).toBe(true);
    });

    // Gone from Active immediately (optimistic) — the contact is now
    // "occupied" by its own archived thread rather than showing the
    // synthetic placeholder alongside it.
    await waitFor(() => expect(screen.queryByText("Atlas Sebastien Bailly")).toBeNull(), { timeout: 10000 });
    first.unmount();

    // A reload: a brand-new mount that fetches from "the server"
    // (serverRows), which now genuinely contains the archived thread.
    expect(serverRows.some((r) => r.email === CONTACT.email && r.folder === "trash")).toBe(true);
    const second = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        filterContacts={[CONTACT]}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull(), { timeout: 10000 });
    expect(screen.queryByText("Atlas Sebastien Bailly")).toBeNull();
    second.unmount();

    const archivedView = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        listSegment="archived"
        filterContacts={[CONTACT]}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull(), { timeout: 10000 });
    await waitFor(() => expect(within(document.querySelector('[data-communication-inbox-list]') as HTMLElement)
      .getAllByText("Atlas Sebastien Bailly").length).toBeGreaterThan(0), { timeout: 10000 });
    archivedView.unmount();
  }, 180000);
});

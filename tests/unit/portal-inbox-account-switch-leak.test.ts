/**
 * @vitest-environment jsdom
 *
 * AXI-134 — "new accounts access other users messages".
 *
 * The inbox caches were keyed only on the SCOPE string
 * (`axis_portal_inbox_manager_v1`), which is byte-identical for every manager.
 * A module-global Map plus a `sessionStorage` mirror therefore survived a
 * sign-out / sign-in inside one tab, and `loadPersistedInbox` — which returns
 * synchronously, before any fetch — handed the second account the first
 * account's threads. The server route was always scoped correctly; the whole
 * leak was this client cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import {
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
  countUnopenedPersistedInbox,
  loadPersistedInbox,
  seedDemoInbox,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

function thread(id: string, from: string): PersistedInboxThread {
  return {
    id,
    folder: "inbox",
    from,
    email: `${from}@example.com`,
    subject: "Rent question",
    preview: "hi",
    body: "hi",
    time: "Sep 3",
    unread: true,
  };
}

const PRIVATE = [thread("t-1", "alice"), thread("t-2", "bob")];

describe("inbox cache is scoped to the viewer", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setPortalSessionViewer(null);
  });

  it("does not serve one account's threads to the next account in the same tab", () => {
    setPortalSessionViewer("manager-a");
    seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, PRIVATE);
    expect(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, [])).toHaveLength(2);

    // Sign out, then sign in as somebody else — same tab, same module instance.
    setPortalSessionViewer(null);
    setPortalSessionViewer("manager-b");

    const seenByB = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []);
    expect(seenByB).toEqual([]);
    expect(JSON.stringify(seenByB)).not.toContain("alice");
  });

  it("leaks nothing through the unread badge count either", () => {
    setPortalSessionViewer("manager-a");
    seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, PRIVATE);
    expect(countUnopenedPersistedInbox(MANAGER_INBOX_STORAGE_KEY, [])).toBe(2);

    setPortalSessionViewer("manager-b");
    expect(countUnopenedPersistedInbox(MANAGER_INBOX_STORAGE_KEY, [])).toBe(0);
  });

  it("purges the sessionStorage mirror on sign-out, so a reload cannot resurrect it", () => {
    setPortalSessionViewer("manager-a");
    seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, PRIVATE);
    const keysWhileSignedIn = Object.keys(window.sessionStorage).filter((k) =>
      k.startsWith("axis:portal-inbox:"),
    );
    expect(keysWhileSignedIn.length).toBeGreaterThan(0);

    setPortalSessionViewer(null);
    const keysAfterSignOut = Object.keys(window.sessionStorage).filter((k) =>
      k.startsWith("axis:portal-inbox:"),
    );
    expect(keysAfterSignOut).toEqual([]);
  });

  it("keys the mirror by viewer, so two accounts never share a storage slot", () => {
    setPortalSessionViewer("manager-a");
    seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, PRIVATE);
    const keyForA = Object.keys(window.sessionStorage).find((k) =>
      k.startsWith("axis:portal-inbox:"),
    );
    expect(keyForA).toContain("manager-a");
    expect(keyForA).toContain(MANAGER_INBOX_STORAGE_KEY);
  });

  it("isolates every portal scope, not just the manager inbox", () => {
    setPortalSessionViewer("resident-a");
    seedDemoInbox(RESIDENT_INBOX_STORAGE_KEY, PRIVATE);
    expect(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, [])).toHaveLength(2);

    setPortalSessionViewer("resident-b");
    expect(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, [])).toEqual([]);
  });

  it("returns the same account's rows when the identity has not changed", () => {
    setPortalSessionViewer("manager-a");
    seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, PRIVATE);
    setPortalSessionViewer("manager-a");
    expect(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, [])).toHaveLength(2);
  });
});

// @vitest-environment jsdom
//
// The VENDOR Communication portal is driven through the unified `"all"` tabId
// (every non-trash conversation, newest first). Three invariants this locks in:
//
//  1. While the SMS UI is hidden (`smsUiEnabled` false, the default) an
//     inbound-SMS notice must FALL THROUGH into the conversation list. There is
//     no SMS panel to catch it, so filtering it out here makes an inbound text
//     to a vendor silently disappear from BOTH surfaces.
//  2. Row labels come from the ROW's own folder, not the active tab — the "all"
//     list mixes inbox and sent rows, so a sent conversation must show its
//     recipient, not the vendor themselves.
//  3. Selecting rows in the "all" view must actually do something: the bulk
//     toolbar is not gated to the retired folder tabs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const INBOX_THREAD = {
  id: "vnd-thr-1000000001",
  folder: "inbox",
  from: "Dana Ramirez",
  email: "dana@example.com",
  subject: "Roof leak in unit 2",
  preview: "Water through the ceiling",
  body: "Water through the ceiling",
  time: "Jul 20, 2026",
  unread: true,
};
const SENT_THREAD = {
  id: "vnd-thr-1000000002",
  folder: "sent",
  from: "Ace Plumbing",
  email: "manager@example.com",
  subject: "Quote attached",
  preview: "Here is the quote",
  body: "Here is the quote",
  time: "Jul 19, 2026",
  unread: false,
};
// An inbound text arrives in the inbox as an SMS-like notice row.
const SMS_NOTICE = {
  id: "vnd-thr-1000000003",
  folder: "inbox",
  from: "+12065550147",
  email: "+12065550147",
  subject: "New SMS in your inbox",
  preview: "On my way to the unit",
  body: "On my way to the unit",
  time: "Jul 21, 2026",
  unread: true,
};

const THREADS = [INBOX_THREAD, SENT_THREAD, SMS_NOTICE];

vi.mock("@/lib/portal-inbox-storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-inbox-storage")>(
    "@/lib/portal-inbox-storage",
  );
  return {
    VENDOR_INBOX_STORAGE_KEY: "vendor-inbox",
    PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
    inboxThreadSortMs: actual.inboxThreadSortMs,
    loadPersistedInbox: () => THREADS,
    syncPersistedInboxFromServer: () => Promise.resolve(THREADS),
    persistInbox: () => {},
    persistInboxAwait: () => Promise.resolve(),
    invalidatePersistedInboxCache: () => {},
    inboxMutationInFlight: () => false,
    runInboxMutation: (fn: () => unknown) => fn(),
    stagePersistedInboxRows: () => {},
    upsertPersistedInboxRows: () => Promise.resolve(true),
    deleteInboxThreadIds: () => Promise.resolve(true),
    inboxThreadMessages: () => [],
    appendReplyToInboxThread: () => THREADS,
  };
});

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
}));
vi.mock("@/components/portal/inbox-scoped-compose-modal", () => ({ ScopedInboxComposeModal: () => null }));

import { VendorInboxPanel } from "@/components/portal/vendor-inbox-panel";

afterEach(cleanup);

describe("vendor conversation inbox (unified 'all' view)", () => {
  it("keeps an inbound-SMS notice visible while the SMS UI is hidden", () => {
    render(<VendorInboxPanel tabId="all" embeddedInCommunication externalTitleActions />);
    expect(screen.getAllByText("+12065550147").length).toBeGreaterThan(0);
    expect(screen.getAllByText("New SMS in your inbox").length).toBeGreaterThan(0);
  });

  it("routes the SMS notice to the SMS panel once the SMS UI is on", () => {
    render(<VendorInboxPanel tabId="all" embeddedInCommunication externalTitleActions smsUiEnabled />);
    expect(screen.queryByText("New SMS in your inbox")).toBeNull();
    // The email conversations are unaffected.
    expect(screen.getAllByText("Roof leak in unit 2").length).toBeGreaterThan(0);
  });

  it("labels a sent row with its recipient, derived from the row's own folder", () => {
    render(<VendorInboxPanel tabId="all" embeddedInCommunication externalTitleActions />);
    // Sent row shows the recipient, not "Ace Plumbing" (the vendor).
    expect(screen.getAllByText("manager@example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("Ace Plumbing")).toBeNull();
    // Inbox rows still show the sender.
    expect(screen.getAllByText("Dana Ramirez").length).toBeGreaterThan(0);
    // Mixed list gets the mixed header.
    expect(screen.getAllByText("From / To").length).toBeGreaterThan(0);
  });

  // "Archive" is the unified inbox's name for what used to be labelled "Trash"
  // (`bulkMoveToArchive`); the bulk affordance itself is unchanged.
  it("offers bulk Mark read / Archive in the 'all' view", () => {
    const { container } = render(<VendorInboxPanel tabId="all" embeddedInCommunication externalTitleActions />);
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    checkbox.click();
    expect(screen.getAllByText("Mark read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Archive").length).toBeGreaterThan(0);
  });

  it("does not use page scroll mode in Communication shell", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/vendor-communication.tsx"), "utf8");
    expect(src).not.toMatch(/\bpageScroll\b/);
  });

});

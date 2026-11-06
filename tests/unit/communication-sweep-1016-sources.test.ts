import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("C11: one compose, counted tabs", () => {
  it("admin New message is the shared dialog with the shared fields", () => {
    const admin = read("src/components/portal/admin-compose-modal.tsx");
    expect(admin).toContain("PortalDialog");
    expect(admin).toContain("PortalMessageSubjectField");
    expect(admin).toContain("PortalMessageBodyField");
    expect(admin).toContain("PortalMessageScheduleFields");
    expect(admin).not.toContain('from "@/components/ui/modal"');
    expect(admin).toContain('title={initialSchedule ? "Schedule message" : "New message"}');
  });

  /**
   * Admin Communication sends through the admin SURFACE, which means asking for it. A seated
   * Overall admin holds the stored `admin` row and no manager row, so a plain POST to
   * `/api/portal/send-inbox-message` with `senderPortal: "manager"` is refused — while
   * `inbox-eligible-contacts` still fills the recipient picker, so the compose would be invited and
   * then 403. `adminOversightUrl` appends `?oversight=admin` from an `/admin` page and nothing
   * elsewhere, and the server still confirms the role (`resolveAdminOversight`): the parameter is a
   * request for the surface, never the authorization.
   */
  it("admin sends ask for the admin surface, so a seated admin is not refused its own compose", () => {
    const admin = read("src/components/portal/admin-compose-modal.tsx");
    expect(admin).toContain('from "@/lib/auth/admin-oversight.client"');
    expect(admin).toContain('fetch(adminOversightUrl("/api/portal/send-inbox-message")');
    expect(admin).toContain('fetch(adminOversightUrl("/api/portal/scheduled-inbox-messages")');
    // Never a bare POST to either, which would 403 for an admin-only account.
    expect(admin).not.toContain('fetch("/api/portal/send-inbox-message"');
    expect(admin).not.toContain('fetch("/api/portal/scheduled-inbox-messages"');
  });

  /**
   * Compose is not the only admin-surface writer to those tightened routes. The thread pane's
   * Schedule send, the admin inbox's Scheduled read, the scheduled-card hook the pane mounts and
   * the one shared send-now pair all reach them too, and every one of them 401s for a seated
   * Overall admin (stored `admin` row, no manager row) without the oversight ask.
   *
   * `adminOversightUrl` appends nothing off an `/admin` path, so wrapping these shared call sites
   * leaves the manager and resident portals byte-identical.
   */
  for (const [file, label] of [
    ["src/components/portal/admin-thread-pane.tsx", "the admin thread pane's Schedule send"],
    ["src/lib/admin-inbox-source.ts", "the admin inbox's Scheduled read"],
    ["src/components/portal/use-thread-scheduled-cards.tsx", "the scheduled-card hook the admin pane mounts"],
    ["src/components/portal/portal-inbox-selection.tsx", "the one shared send-now pair"],
  ] as const) {
    it(`${label} asks for the admin surface`, () => {
      const src = read(file);
      expect(src).toContain('from "@/lib/auth/admin-oversight.client"');
      // Every scheduled-message call goes through the wrapper, and none of them stays bare —
      // whichever quote the call site spells its URL with.
      expect(src).toContain("fetch(adminOversightUrl(");
      for (const quote of ['"', "'", String.fromCharCode(96)]) {
        expect(src, `a bare ${quote}-quoted scheduled-message call would 401 for a seated admin`)
          .not.toContain(`fetch(${quote}/api/portal/scheduled`);
      }
    });
  }

  it("vendor Active / Archived tabs carry counts like the manager and resident ones", () => {
    const vendor = read("src/components/portal/vendor-communication.tsx");
    expect(vendor).toMatch(/<InboxListSegmentTabs[\s\S]*?counts=\{listSynced \? tabCounts : undefined\}/);
    expect(vendor).toContain('rowsForSegment("archived", "")');
  });
});

describe("C8: a list row has no figure of its own beside the sidebar's number", () => {
  for (const file of [
    "src/components/portal/pro-unified-inbox.tsx",
    "src/components/portal/resident-communication.tsx",
    "src/components/portal/vendor-communication.tsx",
  ]) {
    it(`${file} does not draw a per-message unread count`, () => {
      expect(read(file)).not.toContain("unreadCount");
    });
  }
  it("the assistant row and the dashboard read the sidebar's number", () => {
    expect(read("src/hooks/use-manager-attention-queue.ts")).toContain("managerUnreadConversationCount");
    expect(read("src/components/portal/pro-dashboard.tsx")).toContain("managerUnreadConversationCount");
    expect(read("src/hooks/use-portal-nav-counts.ts")).toContain("publishManagerUnreadConversationCount");
  });
});

describe("C12: Communication page reads go through sharedGet", () => {
  it("the five routes", () => {
    expect(read("src/lib/manager-sms-conversations-client.ts")).toContain("sharedGet(");
    // The threads read carries the active workspace as a cache-key-only param, so the URL
    // no longer sits on the `sharedGet(` line itself.
    const inboxStorage = read("src/lib/portal-inbox-storage.ts");
    expect(inboxStorage).toMatch(/sharedGet\(\s*`\/api\/portal-inbox-threads\?scope=\$\{encodeURIComponent\(key\)\}\$\{workspaceCacheKeyParam\(\)\}`/);
    expect(read("src/lib/sms/manager-messaging-number-client.ts")).toContain("sharedGet(MESSAGING_NUMBER_URL)");
    expect(read("src/components/portal/pro-inbox.tsx")).toContain("sharedGet(assistantEmailUrl(");
    expect(read("src/components/portal/pro-work-number-card.tsx")).toContain("sharedGet(assistantEmailUrl(");
    for (const file of [
      "src/components/portal/pro-communication-compose-modal.tsx",
      "src/components/portal/vendor-inbox-panel.tsx",
      "src/components/portal/resident-inbox-panel.tsx",
    ]) {
      expect(read(file)).toMatch(/sharedGet\("\/api\/portal\/inbox-eligible-contacts/);
    }
  });
});

describe("C9: identity boxes", () => {
  it("the label shares its line with the actions instead of padding around them, and the value has a tooltip", () => {
    const card = read("src/components/portal/portal-inbox-contact-card.tsx");
    expect(card).not.toContain("paddingRight");
    expect(card).toContain("title={box.value}");
  });
});

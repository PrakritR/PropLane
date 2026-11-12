// "Resident asked for you": a successful in-app send_message_to_manager also writes a manager Needs-attention item, and the
// assistant may say "notified" only after that write succeeded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notify }));

import { buildManagerAttentionRows } from "@/lib/manager-attention-queue";
import { countResidentHandoffs, RESIDENT_HANDOFF_NOTICE_TYPE } from "@/lib/resident-handoff";
import { recordResidentHandoff } from "@/lib/resident-handoff.server";
import { RESIDENT_SYSTEM_PROMPT } from "@/lib/agent/resident-system-prompt";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const base = {
  basePath: "/portal", overdueChargeCount: 0, overdueBalanceLabel: "$0", pendingApplicationCount: 0, managerSignatureLeaseCount: 0,
  pendingTourCount: 0, messagingNeedsSetup: false, messagingSettingsHref: "/portal/settings", draftPropertyCount: 0,
  draftsHref: "/portal/properties/drafts", unreadConversationCount: 0,
};
const msg = (id: string, over: Record<string, unknown> = {}) => ({ id, from: "PropLane Assistant", body: "x", at: "2026-11-10T00:00:00Z", outbound: false, ...over });
const notice = (messages: unknown[], over: Record<string, unknown> = {}) =>
  ({ id: "agent_notice_m1", folder: "inbox", unread: true, threadType: "agent_notice", messages, ...over }) as unknown as PersistedInboxThread;

beforeEach(() => notify.mockReset().mockResolvedValue({ delivered: true, suppressed: false }));

describe("the Needs-attention row", () => {
  it("counts handoff notices in an unread Assistant thread, back to the manager's own reply", () => {
    const h = (id: string) => msg(id, { noticeType: RESIDENT_HANDOFF_NOTICE_TYPE });
    expect(countResidentHandoffs([notice([h("a"), msg("b"), h("c")])])).toBe(2);
    expect(countResidentHandoffs([notice([h("a"), msg("r", { outbound: true }), h("c")])])).toBe(1);
  });

  it("clears when the thread is read, archived or not an Assistant thread", () => {
    const h = msg("a", { noticeType: RESIDENT_HANDOFF_NOTICE_TYPE });
    expect(countResidentHandoffs([notice([h], { unread: false })])).toBe(0);
    expect(countResidentHandoffs([notice([h], { folder: "trash" })])).toBe(0);
    expect(countResidentHandoffs([notice([h], { id: "msg_inbox_1", threadType: null })])).toBe(0);
  });

  it("adds a 'Resident asked for you' row alongside the delivery row, without removing it", () => {
    const rows = buildManagerAttentionRows({ ...base, residentHandoffCount: 1, undeliveredConversationCount: 2 });
    expect(rows.map((r) => r.id)).toEqual(["undelivered", "resident-handoff"]);
    expect(rows[1]).toMatchObject({ title: "Resident asked for you", href: "/portal/communication/active" });
    expect(buildManagerAttentionRows({ ...base, residentHandoffCount: 3 })[0].title).toBe("3 residents asked for you");
    expect(buildManagerAttentionRows(base)).toEqual([]);
  });

  it("is fed by both surfaces that build the queue", () => {
    expect(read("src/hooks/use-manager-attention-queue.ts")).toContain("countResidentHandoffs");
    expect(read("src/components/portal/pro-dashboard.tsx")).toContain("residentHandoffCount: countResidentHandoffs(inboxThreads)");
  });
});

describe("recordResidentHandoff", () => {
  const input = { managerUserIds: ["m1", "m1", "m2"], residentUserId: "r1", residentName: "Ambika", subject: "Sink leak", messageHash: "h", dayBucket: "2026-11-10" };

  it("writes one idempotent, stamped notice per distinct manager and reports success", async () => {
    expect(await recordResidentHandoff({} as never, input)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][1]).toMatchObject({ landlordId: "m1", subject: "Resident asked for you", threadType: RESIDENT_HANDOFF_NOTICE_TYPE });
    expect(notify.mock.calls[0][1].idempotencyKey).toMatch(/^resident-handoff:[0-9a-f]{32}$/);
    expect(notify.mock.calls[0][1].idempotencyKey).not.toBe(notify.mock.calls[1][1].idempotencyKey);
  });

  it("reports failure (never throws) when no notice was written", async () => {
    notify.mockRejectedValue(new Error("db"));
    expect(await recordResidentHandoff({} as never, input)).toBe(false);
    notify.mockResolvedValue({ delivered: false, suppressed: true });
    expect(await recordResidentHandoff({} as never, input)).toBe(false);
  });
});

describe("the tool and the prompt", () => {
  const tool = read("src/lib/tools/domains/resident/messaging.ts");
  const handler = tool.slice(tool.indexOf("name: \"send_message_to_manager\""), tool.indexOf("export const scheduleMessageTool"));

  it("writes the item only from the in-app surface and only after the message was delivered", () => {
    expect(handler).toContain('ctx.channel === "portal"');
    expect(handler.indexOf("deliverPortalInboxMessage")).toBeLessThan(handler.indexOf("recordResidentHandoff"));
    expect(handler).toContain("They have been notified");
    expect(handler).toMatch(/managerNotified \? `\$\{sentLine\} They have been notified\.` : sentLine/);
  });

  it("lets the assistant say 'notified' only after that confirmed result", () => {
    expect(RESIDENT_SYSTEM_PROMPT).toContain('says "They have been notified"');
    expect(RESIDENT_SYSTEM_PROMPT).toContain("Never say the manager was notified, alerted or flagged before that confirmed result");
  });
});

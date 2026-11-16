import { describe, expect, it } from "vitest";
import { ADMIN_SMS_MANAGED_FILTER, ADMIN_SMS_UNASSIGNED_FILTER } from "@/lib/admin-sms-filter";
import { placeAdminSmsConversations } from "@/lib/manager-sms-messages.server";
import type { ManagerSmsConversationsPayload, ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

const AMBIKA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VINOD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELF_SERVE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NAMES = new Map([[AMBIKA, "1. Ambika"], [VINOD, "2. Vinod"]]);

const row = (name: string, workspaceId: string | null, at: string): ManagerSmsResidentConversation => ({
  residentUserId: null, residentEmail: null, name, phone: null, propertyLabel: null, workspaceId,
  messages: [{ id: name, direction: "inbound", body: name, fromPhone: null, toPhone: "", messageSid: null, source: "work_number", createdAt: at }],
});

const payload = (residents: ManagerSmsResidentConversation[]): ManagerSmsConversationsPayload =>
  ({ workNumber: "+12066781909", personalPhone: null, phoneVerified: false, forwardInbound: true, smsConfigured: true, residents });

const THREADS = [
  row("ambika-4709A", AMBIKA, "2026-11-15T10:00:00Z"),
  row("ambika-5257", AMBIKA, "2026-11-15T09:00:00Z"),
  row("vinod-house", VINOD, "2026-11-15T08:00:00Z"),
  row("stranger-no-house", null, "2026-11-15T07:00:00Z"),
  // A thread stamped on a workspace that is NOT a PropLane-managed one is never named as a managed placement.
  row("self-serve-stamp", SELF_SERVE, "2026-11-15T06:00:00Z"),
];

const run = (workspaceId: string | null) => placeAdminSmsConversations(payload(THREADS), { names: NAMES, leads: [], workspaceId }).residents.map((r) => r.name);

describe("admin Communication reads every managed workspace's threads (the 206 line's own inbox plus all managed)", () => {
  it("the main list is the PropLane line's own inbox: only what no managed workspace holds yet", () => {
    expect(run(null)).toEqual(["stranger-no-house", "self-serve-stamp"]);
  });

  it("'All managed' lists every managed workspace's thread, newest first, and nothing unplaced", () => {
    expect(run(ADMIN_SMS_MANAGED_FILTER)).toEqual(["ambika-4709A", "ambika-5257", "vinod-house"]);
  });

  it("one managed workspace's filter shows ONLY that workspace's threads: Ambika's houses never appear under Vinod and back", () => {
    expect(run(AMBIKA)).toEqual(["ambika-4709A", "ambika-5257"]);
    expect(run(VINOD)).toEqual(["vinod-house"]);
  });

  it("Unassigned is the complement of managed", () => {
    expect(run(ADMIN_SMS_UNASSIGNED_FILTER)).toEqual(["stranger-no-house", "self-serve-stamp"]);
  });

  it("every placed thread names its workspace; an unplaced one names none", () => {
    const out = placeAdminSmsConversations(payload(THREADS), { names: NAMES, leads: [], workspaceId: ADMIN_SMS_MANAGED_FILTER });
    expect(out.residents.map((r) => [r.name, r.workspaceName])).toEqual([["ambika-4709A", "1. Ambika"], ["ambika-5257", "1. Ambika"], ["vinod-house", "2. Vinod"]]);
    expect(out.workspaces?.map((w) => w.name)).toEqual(["1. Ambika", "2. Vinod"]);
  });

  it("a placed thread LEAVES the admin main list once a workspace holds it (and appears under managed), without duplicating", () => {
    const before = [row("lead-thread", null, "2026-11-15T05:00:00Z")];
    const after = [row("lead-thread", AMBIKA, "2026-11-15T05:00:00Z")];
    const main = (rows: ManagerSmsResidentConversation[]) => placeAdminSmsConversations(payload(rows), { names: NAMES, leads: [], workspaceId: null }).residents.map((r) => r.name);
    const managed = (rows: ManagerSmsResidentConversation[]) => placeAdminSmsConversations(payload(rows), { names: NAMES, leads: [], workspaceId: ADMIN_SMS_MANAGED_FILTER }).residents.map((r) => r.name);
    expect([main(before), managed(before)]).toEqual([["lead-thread"], []]);
    expect([main(after), managed(after)]).toEqual([[], ["lead-thread"]]);
  });
});

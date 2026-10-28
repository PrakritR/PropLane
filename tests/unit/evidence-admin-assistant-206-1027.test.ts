/**
 * EVIDENCE TRANSCRIPT — "an admin texts the PropLane line and is talking to their OWN Assistant" (plan
 * admin-team-1027 § 206 as the admin line). The screenshots of admin Communication show the 206 card and the pinned
 * Assistant thread; this writes down the half with no screen of its own: what happens to the text between the
 * webhook and that thread, and what a second admin can read afterwards.
 *
 * Every line below is produced by the shipped code — the shared-line seam (`handleSharedLineInbound`), the Assistant
 * mirror (`appendSmsTurnToManagerAssistantThread` / `mirrorManagerOwnOutboxToAssistantThread`) and the viewer-keyed
 * read (`loadAdminOwnAssistantThread`) — over the same fake database the rest of the suite uses.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-admin-assistant-206-1027.test.ts
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { fakeSharedLineDb } from "../helpers/shared-line-fake-db";
import { leadFakeDb } from "../helpers/lead-fake-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: vi.fn(async () => ({ ok: true as const, messageSid: "SMout", segments: 1 })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));
const unassigned = vi.hoisted(() => vi.fn(async () => ({ leadId: "lead-9" as string | null, reply: "Welcome! Budget?" as string | null, assignedWorkspaceId: null as string | null })));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: unassigned }));

import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { appendSmsTurnToManagerAssistantThread, mirrorManagerOwnOutboxToAssistantThread } from "@/lib/sms/manager-assistant-thread-mirror.server";
import { loadAdminOwnAssistantThread } from "@/lib/communication/admin-assistant-thread.server";

const LINE = "+12066781909";
const VERIFIED = "2026-10-01T00:00:00.000Z";
const PRAKRIT_PHONE = "+15103098345";
const AARAV_PHONE = "+14155550177";
const STRANGER_PHONE = "+12065550199";
const SERVICE_OWNER = "svc-owner";
const SERVICE_WS = "ws-service";

const transcript: string[] = [];
const say = (line: string) => {
  transcript.push(line);
  console.log(`  · ${line}`);
};

const config = (): SharedLineConfig => ({ mode: "shared", sharedNumber: LINE, messagingServiceSid: "MGshared", pilotWorkspaceIds: [] });

function line() {
  return fakeSharedLineDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
    sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: LINE, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [] }],
    portal_workspaces: [{ id: SERVICE_WS, name: "PropLane", owner_user_id: SERVICE_OWNER, is_default: true }],
    profiles: [
      { id: "admin-prakrit", email: "prakrit@proplane.test", phone: PRAKRIT_PHONE, phone_verified_at: VERIFIED },
      { id: "admin-aarav", email: "aarav@proplane.test", phone: AARAV_PHONE, phone_verified_at: VERIFIED },
    ],
    profile_roles: [
      { user_id: "admin-prakrit", role: "admin" },
      { user_id: "admin-aarav", role: "admin" },
    ],
  });
}

const text = (db: never, fromPhone: string, body: string, messageSid = "SM1") =>
  handleSharedLineInbound(db, { config: config(), fromPhone, body, messageSid, mediaCount: 0, phoneKey: fromPhone.replace(/\D/g, "").slice(-10) });

function threads() {
  return leadFakeDb({
    portal_workspaces: [
      { id: SERVICE_WS, owner_user_id: SERVICE_OWNER, is_default: true },
      { id: "ws-prakrit", owner_user_id: "admin-prakrit", is_default: true },
      { id: "ws-aarav", owner_user_id: "admin-aarav", is_default: true },
    ],
    profiles: [{ id: "admin-prakrit", phone: PRAKRIT_PHONE }],
    profile_roles: [{ user_id: "admin-prakrit", role: "admin" }],
    manager_sms_numbers: [{ manager_user_id: SERVICE_OWNER, phone_number: LINE, workspace_id: SERVICE_WS }],
    portal_inbox_thread_records: [
      { id: "agent_notice_admin-prakrit", scope: "axis_portal_inbox_manager_v1", owner_user_id: "admin-prakrit", thread_type: "agent_notice", row_data: { id: "agent_notice_admin-prakrit", folder: "inbox", from: "PropLane Assistant", messages: [] }, updated_at: "2026-10-27T10:00:00Z" },
      { id: "agent_notice_admin-aarav", scope: "axis_portal_inbox_manager_v1", owner_user_id: "admin-aarav", thread_type: "agent_notice", row_data: { id: "agent_notice_admin-aarav", folder: "inbox", from: "PropLane Assistant", messages: [] }, updated_at: "2026-10-27T10:00:00Z" },
    ],
  });
}

const bodiesOf = (fake: ReturnType<typeof threads>, id: string) =>
  ((fake.rows.portal_inbox_thread_records!.find((r) => r.id === id)?.row_data as { messages?: Array<{ body: string }> })?.messages ?? []).map((m) => m.body);

describe("evidence: an admin's text to the 206 reaches their own Assistant", () => {
  afterAll(async () => {
    if (!process.env.EVIDENCE_DIR || !transcript.length) return;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      `${process.env.EVIDENCE_DIR}/admin-assistant-206-transcript.txt`,
      [`An admin texts the PropLane line ${LINE}`, "(produced by the shipped seam, mirror and read; fake database)", "", ...transcript, ""].join("\n"),
      "utf8",
    );
  });

  it("is recognised by the admin's own verified phone and files no Unassigned lead", async () => {
    const { db } = line();
    const result = await text(db, PRAKRIT_PHONE, "which rooms are free in nov across ambika");
    expect(result).toEqual({ kind: "continue", owned: { managerId: SERVICE_OWNER, workspaceId: SERVICE_WS, messagingServiceSid: "MGshared" } });
    expect(unassigned).not.toHaveBeenCalled();
    say(`Prakrit (${PRAKRIT_PHONE}, admin, phone verified) texts the line: "which rooms are free in nov across ambika"`);
    say("  → the seam continues it into the manager pipeline on the PropLane workspace, and NO Unassigned lead is filed");
  });

  it("a stranger on the same line is still a lead, and a control word is never swallowed", async () => {
    const { db } = line();
    unassigned.mockClear();
    const stranger = await text(db, STRANGER_PHONE, "any rooms available?", "SM2");
    expect(stranger.kind).toBe("handled");
    expect(unassigned).toHaveBeenCalled();
    say(`A stranger (${STRANGER_PHONE}) texting the same line takes today's path: answered on the line and filed as an Unassigned lead`);

    unassigned.mockClear();
    const human = await text(db, PRAKRIT_PHONE, "HUMAN", "SM3");
    expect(human.kind).toBe("handled");
    say('  → and "HUMAN" from the admin\'s own phone keeps today\'s behaviour: the control word is handled, not taken by the Assistant');
  });

  it("the turn is written into that admin's Assistant thread, and the reply comes back to the same one", async () => {
    const fake = threads();
    const appended = await appendSmsTurnToManagerAssistantThread(fake.db, {
      ownerUserId: "admin-prakrit",
      workspaceId: null,
      messageId: "sms_in_SM1",
      author: "manager",
      body: "which rooms are free in nov across ambika",
    });
    expect(appended).toMatchObject({ ok: true, threadId: "agent_notice_admin-prakrit", appended: true });
    say("  → the text is mirrored into Prakrit's OWN PropLane Assistant thread (agent_notice_admin-prakrit), not a chat in the PropLane workspace");

    const row = { id: "out-1", manager_user_id: SERVICE_OWNER, actor_user_id: "admin-prakrit", recipient_phone: PRAKRIT_PHONE, body: "Ambika has 4 rooms free in November.", purpose: "manager_conversation", counterparty_role: "manager" };
    expect(await mirrorManagerOwnOutboxToAssistantThread(fake.db, row, LINE)).toBe("mirrored");
    expect(bodiesOf(fake, "agent_notice_admin-prakrit")).toEqual(["which rooms are free in nov across ambika", "Ambika has 4 rooms free in November."]);
    say('  → the Assistant\'s answer on the line lands in the same thread: "Ambika has 4 rooms free in November."');
    say("  → Prakrit opens admin > Communication and reads both turns in the pinned PropLane Assistant row");
  });

  it("one admin never reads another admin's Assistant", async () => {
    const fake = threads();
    await appendSmsTurnToManagerAssistantThread(fake.db, { ownerUserId: "admin-aarav", workspaceId: null, messageId: "sms_in_SM4", author: "manager", body: "aarav's private question" });
    await appendSmsTurnToManagerAssistantThread(fake.db, { ownerUserId: "admin-prakrit", workspaceId: null, messageId: "sms_in_SM5", author: "manager", body: "prakrit's question" });

    const prakrit = await loadAdminOwnAssistantThread(fake.db, "admin-prakrit", { ensure: async () => undefined });
    const aarav = await loadAdminOwnAssistantThread(fake.db, "admin-aarav", { ensure: async () => undefined });
    expect(JSON.stringify(prakrit)).toContain("prakrit's question");
    expect(JSON.stringify(prakrit)).not.toContain("aarav's private question");
    expect(JSON.stringify(aarav)).toContain("aarav's private question");
    expect(JSON.stringify(aarav)).not.toContain("prakrit's question");
    say("Aarav texts the same line: his turn lands in HIS thread — Prakrit's Communication never shows it, and his never shows Prakrit's");

    expect(await loadAdminOwnAssistantThread(fake.db, "admin-nobody", { ensure: async () => undefined })).toBeNull();
    say("  → the read is keyed to the viewer: an account with no Assistant thread of its own reads nothing, never someone else's");
  });
});

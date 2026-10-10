/**
 * Evidence harness for work-number messaging (2026-10-09).
 *
 * Runs the real pipelines against a fake database and records what actually
 * leaves the building — every outbound text (to, from, body) and notice email,
 * plus the inbox threads each person ends up with. Only the two transports and
 * the provisioned line / work address are stubbed; the routing, scoping,
 * dedupe and copy are the product's own.
 *
 * With EVIDENCE_DIR set it writes `work-number-messaging.txt`, a transcript of
 * exactly what the owner's and teammates' phones and inboxes receive.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { createFakeDb } from "../helpers/fake-table-db";

const OWNER = "owner-1";
const MATE_HOUSE = "mate-house"; // teammate assigned 5257 Brooklyn
const MATE_OTHER = "mate-other"; // teammate on a different house
const WS = "ws-seattle";
const HOUSE = "house-5257";
const WORK_NUMBER = "+12065550100";
const WORK_EMAIL = "seattle@proplane.email";
const verified = "2026-10-01T00:00:00.000Z";

const log: string[] = [];
const say = (line = "") => log.push(line);

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

// The provisioned work line for the workspace (Twilio-backed in production).
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: async () => WORK_NUMBER,
  resolveWorkspaceSendLine: async () => ({ phoneNumber: WORK_NUMBER, numberId: "line-ws1" }),
}));
// The workspace's work email (provisioned the same way).
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveWorkspaceWorkEmail: async () => ({ address: WORK_EMAIL, workspaceName: "Seattle Homes" }),
}));

// ---- the two transports, recorded ------------------------------------------
type Sms = { to: string; from: string; body: string; purpose: string; dedupeKey?: string; billedTo?: string };
const texts: Sms[] = [];
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: async (args: Record<string, unknown>) => {
    texts.push({
      to: String(args.to), from: String(args.fromNumber), body: String(args.text),
      purpose: String(args.purpose), dedupeKey: args.dedupeKey as string | undefined,
      billedTo: String((args.log as { managerUserId?: string } | undefined)?.managerUserId ?? ""),
    });
    return { ok: true, durablyAccepted: true, outboxStatus: "queued" };
  },
  sendFromManagerWorkNumber: vi.fn(),
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: async (input: Record<string, unknown>) => {
    texts.push({
      to: String(input.recipientPhone), from: WORK_NUMBER, body: String(input.body),
      purpose: String(input.purpose), dedupeKey: input.dedupeKey as string | undefined,
      billedTo: String(input.managerUserId),
    });
    return { ok: true as const, outboxId: `o${texts.length}`, status: "queued", deduplicated: false };
  },
}));
type Mail = { to: string; from: string; subject: string; text: string };
const mails: Mail[] = [];
vi.mock("@/lib/portal-email-send.server", () => ({
  sendPortalConversationEmails: async (input: Record<string, unknown>) => {
    const to = (input.toEmails as string[] | undefined) ?? [];
    mails.push({
      to: to.join(", "),
      from: String(input.fromAddress ?? ""),
      subject: String(input.subject ?? ""),
      text: String(input.text ?? "").trim(),
    });
    return new Map(to.map((email) => [email, { sent: true, resendId: "evidence" }]));
  },
}));

import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { postTeamThreadMessage, relayTeamChatMessageToSms } from "@/lib/team-comms.server";
import { forwardInboundToTeammates } from "@/lib/sms/inbound-forward-team.server";

function seed() {
  return createFakeDb({
    portal_workspaces: [
      { id: "ws-default", owner_user_id: OWNER, is_default: true, name: "Default" },
      { id: WS, owner_user_id: OWNER, is_default: false, name: "Seattle Homes" },
    ],
    manager_property_records: [{ id: HOUSE, workspace_id: WS, row_data: { title: "5257 Brooklyn Ave" } }],
    account_link_invites: [
      {
        inviter_user_id: OWNER, invitee_user_id: MATE_HOUSE, status: "accepted", workspace_id: WS, team_role: "admin",
        assigned_property_ids: [HOUSE], property_co_manager_permissions: { [HOUSE]: { payments: true, inbox: true } },
      },
      {
        inviter_user_id: OWNER, invitee_user_id: MATE_OTHER, status: "accepted", workspace_id: WS, team_role: "admin",
        assigned_property_ids: ["house-other"], property_co_manager_permissions: { "house-other": { payments: true, inbox: true } },
      },
    ],
    profiles: [
      { id: OWNER, full_name: "Ambika Mago", email: "ambika@example.test", phone: "+12065550111", phone_verified_at: verified },
      { id: MATE_HOUSE, full_name: "Prakrit Ramachandran", email: "prakrit@example.test", phone: "+12065550101", phone_verified_at: verified },
      { id: MATE_OTHER, full_name: "Akshaya K", email: "akshaya@example.test", phone: "+12065550102", phone_verified_at: verified },
    ],
    // Both the owner and the teammate ask for texts as well as the Assistant.
    manager_automation_settings: [
      { manager_user_id: OWNER, row_data: { managerNotificationDestination: "both" } },
      { manager_user_id: MATE_HOUSE, row_data: { managerNotificationDestination: "both" } },
      { manager_user_id: MATE_OTHER, row_data: { managerNotificationDestination: "both" } },
    ],
    portal_inbox_thread_records: [],
    manager_sms_messages: [{ manager_user_id: OWNER, resident_phone: "+12065559999", resident_user_id: "res-1" }],
    sms_outbox: [],
    portal_lease_pipeline_records: [],
    portal_outbound_mail_records: [],
  });
}

const NAMES: Record<string, string> = {
  [OWNER]: "Ambika (owner)",
  [MATE_HOUSE]: "Prakrit (teammate · has 5257)",
  [MATE_OTHER]: "Akshaya (teammate · other house)",
};
const PHONES: Record<string, string> = { "+12065550111": NAMES[OWNER]!, "+12065550101": NAMES[MATE_HOUSE]!, "+12065550102": NAMES[MATE_OTHER]! };
const EMAILS: Record<string, string> = { "ambika@example.test": NAMES[OWNER]!, "prakrit@example.test": NAMES[MATE_HOUSE]!, "akshaya@example.test": NAMES[MATE_OTHER]! };

function dumpTexts() {
  if (texts.length === 0) say("  (no text went out)");
  for (const sms of texts) {
    say(`  SMS  ${sms.from}  →  ${sms.to}  (${PHONES[sms.to] ?? "unknown"})`);
    for (const line of sms.body.split("\n")) say(`       │ ${line}`);
    say(`       purpose=${sms.purpose}  billed to=${NAMES[sms.billedTo ?? ""] ?? sms.billedTo}  dedupe=${sms.dedupeKey ?? "—"}`);
  }
}
function dumpMails() {
  for (const mail of mails) {
    say(`  MAIL ${mail.from}  →  ${mail.to}  (${EMAILS[mail.to] ?? "unknown"})`);
    say(`       subject: ${mail.subject}`);
  }
}
function dumpThreads(fake: ReturnType<typeof seed>) {
  for (const row of fake.tables.portal_inbox_thread_records ?? []) {
    const data = row.row_data as { subject?: string; messages?: Array<{ from?: string; body?: string; channel?: string }> };
    say(`  THREAD ${row.id}`);
    say(`         owner=${NAMES[String(row.owner_user_id)] ?? row.owner_user_id}  type=${row.thread_type}  subject="${data.subject ?? ""}"`);
    for (const message of data.messages ?? []) say(`         · ${message.from ?? ""}${message.channel ? ` [${message.channel}]` : ""}: ${message.body ?? ""}`);
  }
}

beforeEach(() => {
  texts.length = 0;
  mails.length = 0;
});

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/work-number-messaging.txt`, `${log.join("\n")}\n`);
});

describe("evidence · work-number messaging", () => {
  it("a payment notice reaches the owner and the teammate with that house, by Assistant, text and email", async () => {
    const fake = seed();
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: OWNER,
      propertyId: HOUSE,
      module: "payments",
      category: "payment_reminders",
      subject: "Rent · Payment update",
      text: "$1,000.00 was received for 5257 Brooklyn Ave · Room 2.",
      teammateText: "Ambika recorded $1,000.00 for 5257 Brooklyn Ave · Room 2.",
      idempotencyKey: "action-event:payment-1:manager",
    } as never);

    say("1. ASSISTANT NOTICE — $1,000 recorded on 5257 Brooklyn Ave");
    say("   One Assistant thread per person per workspace; the text leaves the workspace's");
    say("   work number and the mail the workspace's work email, both billed to the owner.");
    say();
    dumpThreads(fake);
    dumpTexts();
    dumpMails();
    say();

    const threadIds = (fake.tables.portal_inbox_thread_records ?? []).map((r) => String(r.id)).sort();
    expect(threadIds).toEqual([`agent_notice_${MATE_HOUSE}__${WS}`, `agent_notice_${OWNER}__${WS}`].sort());
    expect(texts.map((t) => t.to).sort()).toEqual(["+12065550101", "+12065550111"]);
    expect(texts.every((t) => t.from === WORK_NUMBER)).toBe(true);
    // Akshaya does not have the house, so nothing reaches her.
    expect(texts.some((t) => t.to === "+12065550102")).toBe(false);
    expect(mails.map((m) => m.to).sort()).toEqual(["ambika@example.test", "prakrit@example.test"]);
    expect(mails.every((m) => m.from.includes(WORK_EMAIL))).toBe(true);
  });

  it("one Team chat per workspace, relayed to every other member by text from the work number", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    await postTeamThreadMessage(db, {
      ownerManagerUserId: OWNER, workspaceId: WS, actorUserId: MATE_HOUSE,
      actorName: "Prakrit Ramachandran", text: "I'll meet the plumber at 5257 at 5.", messageId: "m1", channel: "app",
    } as never);
    await relayTeamChatMessageToSms(db, {
      ownerManagerUserId: OWNER, workspaceId: WS, senderUserId: MATE_HOUSE,
      senderName: "Prakrit Ramachandran", text: "I'll meet the plumber at 5257 at 5.", messageId: "m1",
    } as never);
    // A second poster lands in the SAME chat rather than opening another one.
    await postTeamThreadMessage(db, {
      ownerManagerUserId: OWNER, workspaceId: WS, actorUserId: OWNER,
      actorName: "Ambika Mago", text: "Thanks — I'll leave the key out.", messageId: "m2", channel: "sms",
    } as never);

    say("2. TEAM CHAT — one chat per workspace, relayed over text");
    say();
    dumpThreads(fake);
    dumpTexts();
    say();

    expect(fake.tables.portal_inbox_thread_records).toHaveLength(1);
    expect(fake.tables.portal_inbox_thread_records![0]!.id).toBe(`team-thread:${OWNER}:ws:${WS}`);
    expect(texts.map((t) => t.to).sort()).toEqual(["+12065550102", "+12065550111"]);
    expect(texts.every((t) => t.body === "Prakrit: I'll meet the plumber at 5257 at 5.")).toBe(true);
    expect(texts.some((t) => t.to === "+12065550101")).toBe(false); // never back to the sender
  });

  it("a resident's text is forwarded to the teammates who have that house", async () => {
    const fake = seed();
    await forwardInboundToTeammates(fake as unknown as SupabaseClient, {
      managerUserId: OWNER, workspaceId: WS, houseId: HOUSE, fromPhone: "+12065559999",
      body: "The sink is leaking", messageSid: "SM1",
    } as never);

    say("3. INBOUND RESIDENT TEXT — forwarded to the teammates with that house");
    say("   The resident texted the work number; only teammates assigned 5257 are told.");
    say();
    dumpTexts();
    say();

    expect(texts.map((t) => t.to)).toEqual(["+12065550101"]);
    expect(texts[0]!.from).toBe(WORK_NUMBER);
    expect(texts[0]!.body).toContain("The sink is leaking");
  });
});

// @vitest-environment jsdom
/**
 * Evidence harness for the team-notice fix (2026-10-14): a routine
 * manager-audience event is ONE PropLane line in the workspace Team chat,
 * relayed by text per each teammate's team-texting setting; the owner keeps
 * their Assistant notice; a teammate's own Assistant is noticed only when the
 * event is urgent; a non-owner manager recipient gets no portal inbox thread
 * of their own for a routine event.
 *
 * It drives the REAL `emitActionEvent` against the in-memory PostgREST stub,
 * then draws what each person's Communication list and Team chat actually
 * hold, with the real inbox components. With EVIDENCE_DIR set it dumps the
 * markup for screenshotting and a plain-text delivery transcript, the same
 * convention as `evidence-team-chat-inbox-1009.test.tsx`. Every shot is
 * written BEFORE the assertions that read the same facts, so running this file
 * against the pre-fix commit still produces its "before" pictures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createMemoryDb } from "./support/memory-supabase";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

const notifyManager = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));

const deliverPortalInbox = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] })),
);
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: deliverPortalInbox }));

const enqueueOwnerSms = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true as const, outboxId: "outbox-1", status: "queued", deduplicated: false,
  })),
);
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>) => enqueueOwnerSms(input),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+12065550199", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

import {
  InboxAvatar,
  InboxConversationRow,
  InboxMessageTimeline,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";
import { emitActionEvent } from "@/lib/action-events.server";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { teamThreadRowForViewer } from "@/lib/team-thread-view";
import { TEAM_ROOT_TEXT, teamThreadDisplayName } from "@/lib/team-thread-display";

const OUT = process.env.EVIDENCE_DIR ?? "";
const WORKSPACE = "Seattle Homes";
const HOUSE = "house-1";
const OWNER = "owner-ambika";
const KHUE = "mate-khue";
const JAARAV = "mate-jaarav";
const PEOPLE: Record<string, string> = {
  [OWNER]: "Ambika Mago (owner)",
  [KHUE]: "Khue Pham (property manager)",
  [JAARAV]: "Jaarav Shah (property manager)",
};
const verified = "2026-10-01T00:00:00.000Z";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1280px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

function writeText(name: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, body.endsWith("\n") ? body : `${body}\n`);
}

function invite(userId: string, role: string) {
  const stamp = stampTeamRolePermissions(role as never);
  return {
    inviter_user_id: OWNER, invitee_user_id: userId, status: "accepted", workspace_id: "ws-1", team_role: role,
    house_scope: "selected", assigned_property_ids: [HOUSE], co_manager_permissions: stamp,
    property_co_manager_permissions: { [HOUSE]: stamp },
  };
}

/** Ambika's workspace: her plus two property managers who hold 5257 Brooklyn, all with team texting on. */
function seed() {
  return createMemoryDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, name: WORKSPACE, is_default: true }],
    manager_property_records: [{ id: HOUSE, manager_user_id: OWNER, workspace_id: "ws-1", row_data: {} }],
    profiles: [
      { id: OWNER, email: "ambika@x.com", full_name: "Ambika Mago", phone: "+12065550100", phone_verified_at: verified },
      { id: KHUE, email: "khue@x.com", full_name: "Khue Pham", phone: "+12065550101", phone_verified_at: verified, sms_forward_inbound: true },
      { id: JAARAV, email: "jaarav@x.com", full_name: "Jaarav Shah", phone: "+12065550102", phone_verified_at: verified, sms_forward_inbound: true },
    ],
    account_link_invites: [invite(KHUE, "property_manager"), invite(JAARAV, "property_manager")],
    portal_inbox_thread_records: [],
    action_events: [],
    action_event_deliveries: [],
    sms_outbox: [],
  });
}

type Db = ReturnType<typeof seed>;
const asDb = (db: Db) => db as unknown as SupabaseClient;

/**
 * A resident files a service request at 5257 Brooklyn. The event names all
 * three managers as `manager` recipients, exactly as the service routes do.
 */
function serviceRequestEvent(db: Db, over: Record<string, unknown> = {}, title = "Access or lock issue") {
  const rendered = {
    subject: `Service · ${title}`,
    text: `New service request: ${title} at 5257 Brooklyn Ave · Room 2.`,
  };
  return emitActionEvent(asDb(db), {
    eventId: "wo-7781:created",
    domain: "work_order",
    event: "created",
    managerUserId: OWNER,
    entityId: "wo-7781",
    category: "maintenance",
    senderUserId: "resident-dani",
    senderEmail: "dani@x.com",
    senderName: "Dani Reyes",
    // A row written before the rename still carries the retired word in its
    // stored title; the Team line must not repeat it back to a person.
    payload: {
      title: "Work order · Access or lock issue",
      propertyId: HOUSE,
      propertyLabel: "5257 Brooklyn Ave · Room 2",
      emergency: false,
    },
    recipients: [OWNER, KHUE, JAARAV].map((userId) => ({ audience: "manager" as const, userId, rendered })),
    now: new Date("2026-10-14T16:46:00.000Z"),
    ...over,
  } as Parameters<typeof emitActionEvent>[1]);
}

type Convo = { name: string; preview: string; time: string; kind: "team" | "assistant" | "person" };

const teamRows = (db: Db) =>
  (db.__tables.portal_inbox_thread_records ?? []).filter((r) => r.thread_type === "team");
const teamLines = (db: Db) =>
  teamRows(db).flatMap((r) => ((r.row_data as { messages?: Array<{ id: string; from: string; body: string }> }).messages ?? []));

/** What one person's Communication → Active list holds after the event, from what the pipeline actually did. */
function conversationsFor(db: Db, viewerUserId: string): Convo[] {
  const list: Convo[] = [];
  for (const row of teamRows(db)) {
    const data = row.row_data as { from?: string; preview?: string; time?: string };
    list.push({
      name: String(data.from ?? teamThreadDisplayName(WORKSPACE)),
      preview: `PropLane: ${String(data.preview ?? "")}`,
      time: String(data.time ?? ""),
      kind: "team",
    });
  }
  for (const call of notifyManager.mock.calls) {
    const args = call[1] as { landlordId: string; subject: string; text: string };
    if (args.landlordId !== viewerUserId) continue;
    list.push({ name: "PropLane Assistant", preview: args.text, time: "9:46 AM", kind: "assistant" });
  }
  for (const call of deliverPortalInbox.mock.calls) {
    const args = call[1] as { toUserIds?: string[]; fromName?: string; text: string };
    if (!args.toUserIds?.includes(viewerUserId)) continue;
    list.push({ name: String(args.fromName ?? "PropLane"), preview: args.text, time: "9:46 AM", kind: "person" });
  }
  return list;
}

function ConversationList({ viewerUserId, rows }: { viewerUserId: string; rows: Convo[] }) {
  return (
    <div data-viewer={viewerUserId}>
      <div className="mb-2 text-xs font-semibold text-muted">{PEOPLE[viewerUserId]}</div>
      <div className="rounded-xl border border-border bg-card">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">No conversations</div>
        ) : (
          rows.map((row, i) => (
            <InboxConversationRow
              key={`${row.kind}-${i}`}
              listVariant="manager"
              name={row.name}
              preview={row.preview}
              time={row.time}
              onOpen={() => {}}
            />
          ))
        )}
      </div>
      <div className="mt-1.5 text-[11px] text-muted">{rows.length} conversation{rows.length === 1 ? "" : "s"}</div>
    </div>
  );
}

/** The Team chat as this viewer opens it, drawn from the one stored row. */
function TeamChatPane({ db, viewerUserId }: { db: Db; viewerUserId: string }) {
  const stored = teamRows(db)[0];
  const name = teamThreadDisplayName(WORKSPACE);
  const messages: InboxBubbleMessage[] = [];
  if (stored) {
    const row = teamThreadRowForViewer(stored.row_data as Record<string, unknown>, viewerUserId);
    messages.push({
      id: "root", author: name, body: String(row.body ?? TEAM_ROOT_TEXT),
      at: String((row as { rootAt?: string }).rootAt ?? ""), direction: "inbound",
    });
    for (const message of (row.messages as Array<Record<string, unknown>>) ?? []) {
      messages.push({
        id: String(message.id),
        author: String(message.from),
        body: String(message.body),
        at: String(message.at ?? ""),
        direction: message.outbound === true ? "outbound" : "inbound",
      });
    }
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-viewer={viewerUserId}>
      <div className="mb-3 flex items-center gap-2.5 border-b border-border pb-3">
        <InboxAvatar name={name} tile className="h-9 w-9 rounded-lg" />
        <div>
          <div className="text-sm font-semibold">{name}</div>
          <div className="text-xs text-muted">Opened by {PEOPLE[viewerUserId]}</div>
        </div>
      </div>
      {messages.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted">No Team chat was created for this event.</div>
      ) : (
        <InboxMessageTimeline messages={messages} showAuthors />
      )}
    </div>
  );
}

function transcript(db: Db, title: string): string {
  const lines = [title, "=".repeat(title.length), ""];
  lines.push("Team chat lines posted:");
  const posted = teamLines(db);
  if (posted.length === 0) lines.push("  (none)");
  for (const line of posted) lines.push(`  [${line.id}] ${line.from}: ${line.body}`);
  lines.push("", "Teammate / owner Assistant notices (notifyManagerFromAgent):");
  if (notifyManager.mock.calls.length === 0) lines.push("  (none)");
  for (const call of notifyManager.mock.calls) {
    const args = call[1] as { landlordId: string; subject: string };
    lines.push(`  -> ${PEOPLE[args.landlordId] ?? args.landlordId}: ${args.subject}`);
  }
  lines.push("", "Person-to-person portal inbox conversations (deliverPortalInboxMessage):");
  if (deliverPortalInbox.mock.calls.length === 0) lines.push("  (none)");
  for (const call of deliverPortalInbox.mock.calls) {
    const args = call[1] as { toUserIds?: string[]; messageId?: string };
    lines.push(`  -> ${(args.toUserIds ?? []).map((id) => PEOPLE[id] ?? id).join(", ")}  [${args.messageId}]`);
  }
  lines.push("", "Texts billed to the owner's work number:");
  if (enqueueOwnerSms.mock.calls.length === 0) lines.push("  (none)");
  for (const call of enqueueOwnerSms.mock.calls) {
    const args = call[0] as { recipientUserId?: string; purpose?: string; body?: string };
    lines.push(`  -> ${PEOPLE[args.recipientUserId ?? ""] ?? args.recipientUserId} (${args.purpose}): ${args.body}`);
  }
  return lines.join("\n");
}

beforeEach(() => {
  notifyManager.mockClear();
  deliverPortalInbox.mockClear();
  enqueueOwnerSms.mockClear();
});
afterEach(cleanup);

describe("a routine service request in a three-person workspace", () => {
  it("is one PropLane line in the Team chat and no conversation of its own for either teammate", async () => {
    const db = seed();
    const result = await serviceRequestEvent(db);

    const lists = (
      <div className="grid gap-4 md:grid-cols-3">
        {[OWNER, KHUE, JAARAV].map((id) => (
          <ConversationList key={id} viewerUserId={id} rows={conversationsFor(db, id)} />
        ))}
      </div>
    );
    const { container } = render(lists);
    const posted = teamLines(db);
    writeShot(
      "01-communication-list-routine",
      `Communication → Active for all three people in "${WORKSPACE}" after a resident files one service request at 5257 Brooklyn Ave · Room 2.\n` +
        `Team chat lines posted by PropLane: ${posted.length}. Teammate Assistant notices: ${notifyManager.mock.calls.length}. ` +
        `Person-to-person conversations opened: ${deliverPortalInbox.mock.calls.length}.\n` +
        `Each teammate hears it from the one Team chat row — not from a conversation of their own.`,
      container.innerHTML,
    );
    writeText("routine-service-request-transcript.txt", transcript(db, "Routine service request · wo-7781:created"));

    const { container: panes } = render(
      <div className="grid gap-4 md:grid-cols-2">
        <TeamChatPane db={db} viewerUserId={OWNER} />
        <TeamChatPane db={db} viewerUserId={KHUE} />
      </div>,
    );
    writeShot(
      "02-team-chat-routine",
      `The workspace Team chat, opened by the owner and by a teammate. One PropLane line for the event: ` +
        `"${posted[0]?.body ?? "(none)"}". The stored row's title was "Work order · Access or lock issue"; the line says service request, never work order.`,
      panes.innerHTML,
    );

    // The event succeeded and the owner alone kept a person-to-person message.
    expect(result.failed).toBe(0);
    expect(result.delivered).toBe(3);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      id: "action-event:wo-7781:created:team",
      from: "PropLane",
      body: "Service request · Access or lock issue · 5257 Brooklyn Ave · Room 2 · filed by Dani Reyes · open",
    });
    expect(posted[0]!.body).not.toMatch(/work order/i);
    // No teammate Assistant notice, no teammate inbox thread, nothing in the
    // inbox but the one Team chat row.
    expect(notifyManager.mock.calls).toHaveLength(0);
    expect(deliverPortalInbox.mock.calls.map((c) => (c[1] as { toUserIds?: string[] }).toUserIds)).toEqual([[OWNER]]);
    expect(db.__tables.portal_inbox_thread_records).toHaveLength(1);
    // Each teammate's list is the Team chat alone; the owner's is the Team chat
    // plus the resident's own message.
    expect(conversationsFor(db, KHUE).map((r) => r.kind)).toEqual(["team"]);
    expect(conversationsFor(db, JAARAV).map((r) => r.kind)).toEqual(["team"]);
    expect(conversationsFor(db, OWNER).map((r) => r.kind)).toEqual(["team", "person"]);
    // The line is relayed by text to each teammate on the owner's number, once.
    expect(enqueueOwnerSms.mock.calls.map((c) => c[0].recipientUserId).sort()).toEqual([JAARAV, KHUE].sort());
  });
});

describe("the same event marked Emergency", () => {
  it("still posts one line, prefixed Emergency, and does notice each teammate directly", async () => {
    const db = seed();
    await serviceRequestEvent(
      db,
      {
        eventId: "wo-7782:created",
        urgent: true,
        payload: {
          title: "Work order · No heat", propertyId: HOUSE,
          propertyLabel: "5257 Brooklyn Ave · Room 2", emergency: true,
        },
      },
      "No heat",
    );

    const { container } = render(
      <div className="grid gap-4 md:grid-cols-3">
        {[OWNER, KHUE, JAARAV].map((id) => (
          <ConversationList key={id} viewerUserId={id} rows={conversationsFor(db, id)} />
        ))}
      </div>,
    );
    const posted = teamLines(db);
    writeShot(
      "03-communication-list-urgent",
      `The same surface for an Emergency service request. Urgency is the one case that still reaches each teammate's own PropLane Assistant ` +
        `(${notifyManager.mock.calls.length} direct notices), on top of the same single Team chat line: "${posted[0]?.body ?? "(none)"}".`,
      container.innerHTML,
    );
    writeText("urgent-service-request-transcript.txt", transcript(db, "Emergency service request · wo-7782:created"));

    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe("Emergency · Service request · No heat · 5257 Brooklyn Ave · Room 2 · filed by Dani Reyes · open");
    expect(notifyManager.mock.calls.map((c) => (c[1] as { landlordId: string }).landlordId).sort()).toEqual([JAARAV, KHUE].sort());
    // Their own Assistant notice already texted them; the line never bills the owner twice.
    expect(enqueueOwnerSms.mock.calls).toHaveLength(0);
  });
});

describe("a caller that builds no Team line of its own", () => {
  it("derives one from the notice, labelled by its module, and posts nothing without an idempotency key", async () => {
    const derived = seed();
    await notifyPropertyScopedManagersFromAgent(asDb(derived) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "calendar",
      subject: "Tour booked", text: "You approved it. Jo booked a tour of 5257 Brooklyn Ave for Saturday.",
      idempotencyKey: "action-event:tour-4410:booked:manager",
    });
    const derivedLines = teamLines(derived);

    const keyless = seed();
    await notifyPropertyScopedManagersFromAgent(asDb(keyless) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "services",
      subject: "Service request updated", text: "The vendor replied.",
    });

    const { container } = render(
      <div className="grid gap-4 md:grid-cols-2">
        <TeamChatPane db={derived} viewerUserId={KHUE} />
        <TeamChatPane db={keyless} viewerUserId={KHUE} />
      </div>,
    );
    writeShot(
      "04-derived-and-keyless",
      `Left: a caller that passed no Team line. One line is derived from the notice — the module's own label plus the notice's subject ` +
        `("${derivedLines[0]?.body ?? "(none)"}"), never the owner-addressed body "You approved it…".\n` +
        `Right: the same notice with no idempotency key. No safe id means no line could be posted twice, so none is posted and no Team chat is created.`,
      container.innerHTML,
    );

    expect(derivedLines).toHaveLength(1);
    expect(derivedLines[0]).toMatchObject({ from: "PropLane", body: "Schedule · Tour booked" });
    expect(derivedLines[0]!.id).toBe("action-event:tour-4410:booked:team");
    expect(derivedLines[0]!.body).not.toContain("You approved it");
    expect(teamRows(keyless)).toHaveLength(0);
  });
});

/**
 * Evidence harness — the owner is emailed for every booking (claude-2/bookings-residents-1016).
 *
 * Driven through the REAL save path: the `/api/portal-schedule-records` route's own hooks (the ones
 * the Add booking sheet POSTs into), the REAL `emitNativeBookingEvent` /
 * `emitChannelBookingEvent` / `sendOwnerBookingEmail`, and the REAL `sendManagerNoticeEmail`
 * (which composes the subject, text and HTML and claims the idempotency row). Only the outermost
 * boundaries are faked: the mail transport, the work-email lookup, and the action-event bus — which
 * is made to deliver NOTHING, the way a manager whose alert destination is "none" is set up. The
 * mail still goes out.
 *
 * With EVIDENCE_DIR set it writes the transcript plus the mail bodies as HTML:
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-owner-booking-email-1016.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ config: null as null | Record<string, unknown> }));

vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({ replaceManagerPlannedScheduleSlice: vi.fn() }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn().mockResolvedValue(null) }));

// The manager's alert destination is "none": the bus notice goes nowhere.
const emitActionEvent = vi.fn(async () => ({ eventId: "e", duplicate: false, delivered: 0, submitted: 0, deferred: 0, failed: 0 }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: () => emitActionEvent() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.proplane.test" }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: async () => ({ workspaceId: "ws-seattle", isDefault: true }),
}));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveWorkspaceWorkEmail: async () => ({ address: "seattle-homes@mail.proplane.test", workspaceName: "Seattle Homes" }),
}));

type Mail = { toEmails: string[]; fromAddress: string | null; subject: string; text: string; html: string };
const mailbox: Mail[] = [];
vi.mock("@/lib/portal-email-send.server", () => ({
  sendPortalConversationEmails: async (args: Mail) => {
    mailbox.push(args);
    return new Map(args.toEmails.map((to) => [to, { sent: true }]));
  },
}));

await import("@/app/api/portal-schedule-records/route");
const { emitChannelBookingEvent } = await import("@/lib/channel-booking-events.server");

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
const atomicWrite = () => mocks.config!.atomicWrite as Hook;
const afterWrite = () => mocks.config!.afterWrite as Hook;
const afterDelete = () => mocks.config!.afterDelete as Hook;

const OWNER = { id: "owner-1", role: "manager" };
const OWNER_EMAIL = "owner@seattlehomes.test";
const HOUSE = "seattle-homes-1";
const HOUSE_LABEL = "Seattle Homes · 5259 Brooklyn Ave NE";

/** The owner's profile, the house's rooms, and the claim table the mail dedupes on. Everything else reads empty. */
function fakeDb() {
  const claims = new Set<string>();
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      is: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () =>
        table === "profiles"
          ? { data: { id: OWNER.id, email: OWNER_EMAIL, full_name: "Prakrit R" }, error: null }
          : table === "manager_property_records"
            ? { data: { id: HOUSE, manager_user_id: OWNER.id, property_data: { buildingName: HOUSE_LABEL, listingSubmission: { rooms: [{ id: "room-3", name: "Room 3" }] } } }, error: null }
            : { data: null, error: null },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    if (table === "portal_outbound_mail_records") {
      let id = "";
      chain.upsert = (row: { id: string }) => {
        id = row.id;
        return { select: async () => (claims.has(id) ? { data: [], error: null } : (claims.add(id), { data: [{ id }], error: null })) };
      };
      chain.delete = () => ({ eq: async (_col: string, value: string) => { claims.delete(value); return { error: null }; } });
    }
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, claims };
}

const { db, claims } = fakeDb();

const block = (rowData: Record<string, unknown>, id = "room_block_owner-1_abc") => ({
  id,
  record_type: "room_date_block",
  manager_user_id: OWNER.id,
  property_id: HOUSE,
  row_data: { roomId: "room-3", checkIn: "2026-11-10", checkOut: "2026-11-14", ...rowData },
});

/** `afterWrite` / `afterDelete` hand their work to `after()`, which is unavailable here and runs inline, unawaited. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);

function mailTranscript(mail: Mail): void {
  say(`      To:      ${mail.toEmails.join(", ")}`);
  say(`      From:    ${mail.fromAddress ?? "(PropLane shared sender)"}`);
  say(`      Subject: ${mail.subject}`);
  for (const line of mail.text.split("\n")) say(`      | ${line}`);
}

function writeMailShot(name: string, caption: string, mail: Mail): void {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#eceef2;font-family:ui-sans-serif,system-ui,sans-serif">
<div style="max-width:720px;margin:20px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 12px;white-space:pre-line">${caption}</p>
<div style="background:#fff;border:1px solid rgba(8,9,11,.12);border-radius:12px;overflow:hidden">
<div style="padding:14px 18px;border-bottom:1px solid #eef0f4;font-size:13px;color:#475569;line-height:1.7">
<div><strong style="color:#0f172a">To</strong> &nbsp; ${mail.toEmails.join(", ")}</div>
<div><strong style="color:#0f172a">From</strong> &nbsp; ${(mail.fromAddress ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
<div style="margin-top:6px;font-size:16px;font-weight:600;color:#0f172a">${mail.subject}</div>
</div>
<div style="padding:16px 18px">${mail.html}</div>
</div></div></body></html>`,
    "utf8",
  );
}

afterAll(() => {
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/owner-booking-email-1016.txt`, `${log.join("\n")}\n`, "utf8");
  }
});

beforeEach(() => {
  emitActionEvent.mockClear();
  mailbox.length = 0;
});

describe("evidence · the owner is emailed for every booking", () => {
  it("a booking with no name is refused by the route itself (400), and a closed room needs a reason", async () => {
    say("PropLane · the owner's email for every booking");
    say(`Owner login: ${OWNER_EMAIL} · work email: PropLane Assistant · Seattle Homes <seattle-homes@mail.proplane.test>`);
    say("The action-event bus is set to deliver NOTHING (a manager whose alert destination is 'none').");
    say();
    say("1 · POST /api/portal-schedule-records — a room_date_block with nobody named");
    const nameless = await atomicWrite()({ db, user: OWNER, record: block({}), existing: null });
    say(`      -> ${JSON.stringify(nameless)}`);
    expect(nameless).toMatchObject({ handled: true, status: 400, error: "Add the guest's name, or close the room with a reason." });

    say("2 · the same POST, Closed (no guest) with no reason");
    const noReason = await atomicWrite()({ db, user: OWNER, record: block({ blockKind: "closed" }), existing: null });
    say(`      -> ${JSON.stringify(noReason)}`);
    expect(noReason).toMatchObject({ handled: true, status: 400, error: "Add a reason for closing the room." });

    say('3 · the same POST, Closed (no guest) with the reason "Airbnb" (the import marker)');
    const marker = await atomicWrite()({ db, user: OWNER, record: block({ blockKind: "closed", reason: "Airbnb" }), existing: null });
    say(`      -> ${JSON.stringify(marker)}`);
    expect(marker).toMatchObject({ handled: true, status: 400 });

    say('4 · the same POST, Closed (no guest) · "Painting" — saved, and nobody is emailed: a closed room is not a booking');
    const closed = block({ blockKind: "closed", reason: "Painting" }, "room_block_owner-1_closed");
    expect(await atomicWrite()({ db, user: OWNER, record: closed, existing: null })).toEqual({ handled: false });
    await afterWrite()({ record: closed, existing: null, db });
    await settle();
    say(`      -> saved; emails sent: ${mailbox.length}`);
    say();
    expect(mailbox).toHaveLength(0);
  });

  it("a named booking saved in PropLane emails the owner once, whatever the bus notice does", async () => {
    const booking = block({ residentName: "Maya Chen", residentEmail: "maya@example.test" });
    expect(await atomicWrite()({ db, user: OWNER, record: booking, existing: null })).toEqual({ handled: false });
    await afterWrite()({ record: booking, existing: null, db });
    await settle();

    say("5 · POST the same booking with a name — Maya Chen, Room 3, Nov 10 → Nov 14");
    say(`      action-event bus deliveries: ${emitActionEvent.mock.calls.length} call(s), 0 delivered (destination "none")`);
    say(`      emails sent: ${mailbox.length}`);
    mailTranscript(mailbox[0]!);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.toEmails).toEqual([OWNER_EMAIL]);
    expect(mailbox[0]!.fromAddress).toBe("PropLane Assistant · Seattle Homes <seattle-homes@mail.proplane.test>");
    expect(mailbox[0]!.subject).toBe(`New booking · ${HOUSE_LABEL} · Room 3`);
    for (const line of ["A booking was added.", `House: ${HOUSE_LABEL}`, "Room: Room 3", "Guest: Maya Chen", "Dates: Nov 10 – Nov 14 (4 nights)", "Source: PropLane", "Open in PropLane: https://app.proplane.test/portal/bookings/"]) {
      expect(mailbox[0]!.text).toContain(line);
    }
    writeMailShot(
      "owner-email-booking-created",
      "The mail the workspace owner receives the moment a booking is saved in PropLane (Bookings → Add booking). It leaves from the workspace's own work email and goes to the owner's login address regardless of their alert destination.",
      mailbox[0]!,
    );

    // A retried request, or the same row saved again, is the same event id: no second mail.
    await afterWrite()({ record: booking, existing: booking, db });
    await settle();
    say(`      saving the same booking again -> emails sent: ${mailbox.length} (idempotent on native:<blockId>:booking_created)`);
    say();
    expect(mailbox).toHaveLength(1);
  });

  it("cancelling and deleting that booking each raise the cancellation mail once", async () => {
    const live = block({ residentName: "Maya Chen", residentEmail: "maya@example.test" });
    const cancelled = { ...live, record_type: "cancelled_room_date_block" };
    await afterWrite()({ record: cancelled, existing: live, db });
    await settle();

    say("6 · Cancel booking (the row becomes a cancelled_room_date_block)");
    say(`      emails sent: ${mailbox.length}`);
    mailTranscript(mailbox[0]!);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.subject).toBe(`Booking cancelled · ${HOUSE_LABEL} · Room 3`);
    expect(mailbox[0]!.text).toContain("A booking was cancelled.");
    writeMailShot(
      "owner-email-booking-cancelled",
      "The cancellation mail, raised when the booking is cancelled or deleted. The event id is the block's own, so a cancel followed by a delete mails the owner once.",
      mailbox[0]!,
    );

    // Deleting the row afterwards is the same event id — the owner is not told twice.
    await afterDelete()({ records: [live], db });
    await settle();
    say(`      then deleting the row -> emails sent: ${mailbox.length} (same native:<blockId>:booking_cancelled)`);
    say();
    expect(mailbox).toHaveLength(1);
  });

  it("an Airbnb reservation read off the feed emails the owner too, and only once per sync", async () => {
    const range = { id: "airbnb-uid-9f31", sourceUid: "airbnb-uid-9f31", summary: "Reserved", start: "2026-10-14", end: "2026-10-19", reservationCode: "HMHW5SHXRB" };
    const input = {
      event: "channel_booking_created" as const,
      connectionId: "conn-airbnb-1",
      managerUserId: OWNER.id,
      propertyId: HOUSE,
      roomId: "room-3",
      provider: "airbnb" as const,
      propertyLabel: HOUSE_LABEL,
      roomLabel: "Room 3",
      range,
    };
    await emitChannelBookingEvent(db, input);

    say("7 · Airbnb calendar sync picks up the reservation (channel_booking_created)");
    say(`      emails sent: ${mailbox.length}`);
    mailTranscript(mailbox[0]!);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.subject).toBe(`New booking · ${HOUSE_LABEL} · Room 3`);
    expect(mailbox[0]!.text).toContain("Source: Airbnb");
    writeMailShot(
      "owner-email-airbnb-booking",
      "The same mail for a booking that arrived from a linked Airbnb calendar — raised by the sync, with Airbnb named as the source.",
      mailbox[0]!,
    );

    await emitChannelBookingEvent(db, input);
    say(`      the next sync re-reads the same reservation -> emails sent: ${mailbox.length}`);
    say(`      idempotency claim rows written: ${claims.size > 0 ? "one per booking event" : "none"}`);
    say();
    expect(mailbox).toHaveLength(1);
  });
});

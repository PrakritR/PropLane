/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
// A resident texts a photo of a leak with one line of text. Through the real seam and router the text is
// stamped with their team; the photo is stored privately under that team's owner and indexed with the
// workspace; the repair request the assistant files carries the photo and links it back. Another team's
// photos from the same phone are never attached. The model's decision to file is the only stand-in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { createMemoryDb, type MemoryDb } from "../../unit/support/memory-supabase";

const sim = vi.hoisted(() => ({
  db: null as unknown,
  downloads: [] as string[],
  uploads: [] as Array<{ path: string; contentType: string }>,
  blobs: new Map<string, Uint8Array>(),
  events: [] as Array<{ event: string }>,
  fetchMedia: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => sim.db }));
vi.mock("@/lib/inspections/attachment-intake.server", () => ({ fetchTwilioMessageMedia: sim.fetchMedia }));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: vi.fn(async () => ({ ok: true as const, messageSid: "SMout", segments: 1 })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: vi.fn(async () => ({ leadId: null, reply: null, assignedWorkspaceId: null })) }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: vi.fn(async (_db: unknown, input: { event: string }) => { sim.events.push(input); return {}; }) }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: vi.fn(async () => undefined) }));
vi.mock("@/lib/work-order-auto-time.server", () => ({
  willDispatchRun: vi.fn(async () => false),
  autoTimeNewWorkOrder: vi.fn(async (_db: unknown, _owner: string, row: unknown) => ({ row, outcome: { kind: "none" } })),
  notifyVisitAutoBooked: vi.fn(async () => undefined),
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: vi.fn(async () => ["owner-a"]) }));

import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { ingestInboundMedia } from "@/lib/one-number/inbound-media.server";
import { createWorkOrderFromResidentSms } from "@/lib/claw-maintenance-work-order.server";

const PHONE = "+12065550142";
const KEY = "2065550142";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] };
const MEDIA_SID = "MM" + "a".repeat(32);
const media = (sid: string, n: number) => `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/${sid}/Media/ME${String(n).repeat(32)}`;

function world(): MemoryDb & { storage: unknown } {
  const base = createMemoryDb({
    portal_workspaces: [
      { id: "ws-a", name: "Brooklyn Homes", owner_user_id: "owner-a", is_default: true },
      { id: "ws-b", name: "Eighth Ave Co", owner_user_id: "owner-b", is_default: true },
    ],
    manager_property_records: [{ id: "prop-a1", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" }, property_data: { buildingName: "5259 Brooklyn", address: "5259 Brooklyn Ave NE" } }],
    profiles: [{ id: "user-rae", email: "rae@x.com", full_name: "Rae Resident", phone: PHONE, phone_verified_at: "2026-10-01T00:00:00Z" }],
    manager_application_records: [{ id: "app", manager_user_id: "owner-a", resident_email: "rae@x.com", property_id: "prop-a1", updated_at: "2026-10-01T00:00:00Z", row_data: { bucket: "approved", assignedPropertyId: "prop-a1", assignedRoomChoice: "R2", property: "5259 Brooklyn" } }],
    sms_media_files: [],
    portal_work_order_records: [],
  });
  const storage = {
    from: () => ({
      upload: async (path: string, bytes: Buffer, opts: { contentType: string }) => { sim.uploads.push({ path, contentType: opts.contentType }); sim.blobs.set(path, bytes); return { error: null }; },
      download: async (path: string) => { sim.downloads.push(path); const bytes = sim.blobs.get(path); return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: { message: "missing" } }; },
    }),
  };
  // Column defaults the real table has (id, created_at): the in-memory stub does not invent them.
  const originalFrom = base.from.bind(base);
  base.from = ((table: string) => {
    const builder = originalFrom(table) as any;
    if (table !== "sms_media_files") return builder;
    const upsert = builder.upsert.bind(builder);
    builder.upsert = (rows: any, opts: any) => upsert(
      (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({ id: `file-${Math.random().toString(36).slice(2, 10)}`, created_at: new Date().toISOString(), linked_type: null, linked_id: null, ...r })),
      opts,
    );
    return builder;
  }) as never;
  return Object.assign(base, { storage });
}

beforeEach(() => {
  sim.uploads.length = 0; sim.downloads.length = 0; sim.blobs.clear(); sim.events.length = 0;
  sim.fetchMedia.mockReset().mockResolvedValue({ bytes: Buffer.from([1, 2, 3, 4]), contentType: "image/jpeg" });
});

describe("leak photo to ticket", () => {
  it("routes to the resident's team, stores the photo privately under that team, files the request with the photo, and links it back", async () => {
    const db = world();
    sim.db = db;
    const text = "my kitchen sink is leaking under the cabinet";

    // 1. The text (with one photo) is routed to the resident's team, as that team's owner.
    const seam = await handleSharedLineInbound(db as never, { config, fromPhone: PHONE, body: text, messageSid: MEDIA_SID, mediaCount: 1, phoneKey: KEY });
    expect(seam).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a", managerId: "owner-a" } });
    if (seam.kind !== "continue") return;

    // 2. The pipeline stores the photo: private bucket, owner-scoped path, workspace and sender indexed.
    const stored = await ingestInboundMedia(db as never, {
      messageSid: MEDIA_SID, ownerUserId: seam.owned.managerId, workspaceId: seam.owned.workspaceId, senderPhone: PHONE,
      params: { NumMedia: "1", MediaUrl0: media(MEDIA_SID, 1), MediaContentType0: "image/jpeg" },
    });
    expect(stored).toHaveLength(1);
    expect(sim.uploads).toEqual([{ path: `manager/owner-a/${MEDIA_SID}/0.jpg`, contentType: "image/jpeg" }]);
    expect(db.__tables.sms_media_files![0]).toMatchObject({ workspace_id: "ws-a", sender_phone_key: KEY, linked_type: null, message_sid: MEDIA_SID });

    // 3. The assistant files the request. The photo rides on it and the file is linked to the request.
    const filed = await createWorkOrderFromResidentSms({
      managerUserId: "owner-a", residentPhone: PHONE, residentUserId: "user-rae", residentEmail: "rae@x.com", text, senderUserId: "user-rae",
    });
    expect(filed).toMatchObject({ created: true });
    if (!filed.created) return;
    const order = db.__tables.portal_work_order_records![0]!;
    const rowData = order.row_data as Record<string, unknown>;
    expect(order).toMatchObject({ manager_user_id: "owner-a", resident_email: "rae@x.com", property_id: "prop-a1" });
    expect(rowData).toMatchObject({ bucket: "open", status: "Submitted", propertyName: "5259 Brooklyn", unit: "R2" });
    expect(rowData.photoDataUrls).toEqual([`data:image/jpeg;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`]);
    expect(db.__tables.sms_media_files![0]).toMatchObject({ linked_type: "work_order", linked_id: filed.workOrderId });
  });

  it("another team's photo from the same phone is never attached to this team's request", async () => {
    const db = world();
    sim.db = db;
    // The same phone texted a photo to team B an hour ago and to team A just now.
    await ingestInboundMedia(db as never, { messageSid: "MM" + "b".repeat(32), ownerUserId: "owner-b", workspaceId: "ws-b", senderPhone: PHONE, params: { NumMedia: "1", MediaUrl0: media("MM" + "b".repeat(32), 2), MediaContentType0: "image/jpeg" } });
    await ingestInboundMedia(db as never, { messageSid: MEDIA_SID, ownerUserId: "owner-a", workspaceId: "ws-a", senderPhone: PHONE, params: { NumMedia: "1", MediaUrl0: media(MEDIA_SID, 1), MediaContentType0: "image/jpeg" } });
    const filed = await createWorkOrderFromResidentSms({ managerUserId: "owner-a", residentPhone: PHONE, residentUserId: "user-rae", residentEmail: "rae@x.com", text: "ceiling is leaking in the bathroom" });
    expect(filed).toMatchObject({ created: true });
    const files = db.__tables.sms_media_files!;
    const teamA = files.find((f) => f.workspace_id === "ws-a")!;
    const teamB = files.find((f) => f.workspace_id === "ws-b")!;
    expect(teamA).toMatchObject({ linked_type: "work_order" });
    expect(teamB.linked_type ?? null).toBeNull();
    expect((db.__tables.portal_work_order_records![0]!.row_data as { photoDataUrls: string[] }).photoDataUrls).toHaveLength(1);
  });

  it("a type outside the photo allowlist is dropped, and the request is still filed without it", async () => {
    const db = world();
    sim.db = db;
    sim.fetchMedia.mockResolvedValue({ bytes: Buffer.from([1]), contentType: "application/x-msdownload" });
    const stored = await ingestInboundMedia(db as never, { messageSid: MEDIA_SID, ownerUserId: "owner-a", workspaceId: "ws-a", senderPhone: PHONE, params: { NumMedia: "1", MediaUrl0: media(MEDIA_SID, 1), MediaContentType0: "application/x-msdownload" } });
    expect(stored).toEqual([]);
    expect(sim.uploads).toEqual([]);
    const filed = await createWorkOrderFromResidentSms({ managerUserId: "owner-a", residentPhone: PHONE, residentUserId: "user-rae", residentEmail: "rae@x.com", text: "kitchen sink is leaking" });
    expect(filed).toMatchObject({ created: true });
    expect(db.__tables.portal_work_order_records![0]!.row_data).not.toHaveProperty("photoDataUrls");
  });

  it("a near-identical resend does not file a second request", async () => {
    const db = world();
    sim.db = db;
    const args = { managerUserId: "owner-a", residentPhone: PHONE, residentUserId: "user-rae", residentEmail: "rae@x.com", text: "my kitchen sink is leaking under the cabinet" };
    expect(await createWorkOrderFromResidentSms(args)).toMatchObject({ created: true });
    expect(await createWorkOrderFromResidentSms(args)).toMatchObject({ created: false, alreadyOpen: true });
    expect(db.__tables.portal_work_order_records).toHaveLength(1);
  });
});

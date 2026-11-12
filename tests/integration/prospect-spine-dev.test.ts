/* eslint-disable @typescript-eslint/no-explicit-any -- rows from a real PostgREST client */
// Prospect spine against the DEV/TEST Supabase project only (emstjswhotsnyksqhqyf). Run with:
//   PROSPECT_SPINE_DEV=1 npx vitest run tests/integration/prospect-spine-dev.test.ts
// Seeds a PropLane-managed workspace owned by a CLIENT user with one house (Room 4), a PropLane staff seat for a second user,
// then proves: one thread per phone, tagged house + room, visible to staff and NOT to a stranger, delivery issues, and the
// verified-phone link. Everything it creates is deleted afterwards.
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

config({ path: ".env.local" });
const DEV_REF = "emstjswhotsnyksqhqyf";
const enabled = process.env.PROSPECT_SPINE_DEV === "1" && (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(DEV_REF);
const suite = enabled ? describe : describe.skip;

suite("prospect spine on the dev project", () => {
  const tag = randomUUID().slice(0, 8);
  const digits = String(Math.floor(2000000 + Math.random() * 7000000));
  const PROSPECT = `+1206${digits}`;
  const created = { users: [] as string[], workspace: "", property: "", phones: [PROSPECT] };
  let db: any;
  let ownerId = "";
  let staffId = "";
  let strangerId = "";
  let workspaceId = "";
  let propertyId = "";

  async function makeUser(label: string, role: string, phone?: string, verified = false): Promise<string> {
    const { data, error } = await db.auth.admin.createUser({ email: `spine-${tag}-${label}@proplane-test.invalid`, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("user not created");
    created.users.push(data.user.id);
    await db.from("profiles").upsert({
      id: data.user.id, role, email: `spine-${tag}-${label}@proplane-test.invalid`, full_name: `Spine ${label}`,
      ...(phone ? { phone, phone_verified_at: verified ? new Date().toISOString() : null } : {}),
    }, { onConflict: "id" });
    return data.user.id;
  }

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    ownerId = await makeUser("owner", "manager");
    staffId = await makeUser("staff", "manager");
    strangerId = await makeUser("stranger", "manager");
    const existing = await db.from("portal_workspaces").select("id").eq("owner_user_id", ownerId).eq("is_default", true).maybeSingle();
    workspaceId = existing.data?.id ?? "";
    if (workspaceId) {
      await db.from("portal_workspaces").update({ is_service: true, name: `Spine ${tag}` }).eq("id", workspaceId);
    } else {
      const ins = await db.from("portal_workspaces").insert({ name: `Spine ${tag}`, owner_user_id: ownerId, is_service: true, is_default: true }).select("id").single();
      if (ins.error) throw ins.error;
      workspaceId = ins.data.id;
    }
    created.workspace = workspaceId;
    propertyId = `spine-${tag}`;
    created.property = propertyId;
    const prop = await db.from("manager_property_records").insert({
      id: propertyId, status: "live", manager_user_id: ownerId, workspace_id: workspaceId,
      row_data: { buildingName: "5259 Spine Ave NE", listingSubmission: { rooms: [{ id: "r4", name: "Room 4" }] } },
    });
    if (prop.error) throw prop.error;
    const seat = await db.from("account_link_invites").insert({
      inviter_user_id: ownerId, invitee_user_id: staffId, inviter_axis_id: `AX-${tag}`, tab_kind: "manager", status: "accepted",
      workspace_id: workspaceId, team_role: "admin", house_scope: "all", is_service_seat: true, assigned_property_ids: [],
    });
    if (seat.error) throw seat.error;
  });

  afterAll(async () => {
    if (!db) return;
    await db.from("portal_inbox_thread_records").delete().in("owner_user_id", [ownerId, ...created.users].filter(Boolean));
    await db.from("prospect_contexts").delete().eq("workspace_id", workspaceId);
    await db.from("sms_phone_contacts").delete().in("phone_e164", created.phones);
    await db.from("manager_tour_followup_controls").delete().eq("manager_user_id", ownerId);
    await db.from("manager_sms_conversation_houses").delete().eq("manager_user_id", ownerId);
    await db.from("account_link_invites").delete().eq("workspace_id", workspaceId);
    await db.from("manager_property_records").delete().eq("id", propertyId);
    await db.from("portal_workspaces").delete().eq("id", workspaceId);
    for (const id of created.users) {
      await db.from("profiles").delete().eq("id", id);
      await db.auth.admin.deleteUser(id);
    }
  });

  const input = (eventId: string, body: string) => ({
    workspaceId, ownerUserId: ownerId,
    identity: { kind: "phone" as const, phoneE164: PROSPECT, verified: false },
    context: { propertyId, roomId: "r4", source: "sms" as const }, body, channel: "sms" as const, eventId,
    occurredAt: new Date().toISOString(), notify: false,
  });

  it("two texts from one phone are ONE thread, tagged house + room, one context row", async () => {
    const { recordInbound } = await import("@/lib/prospect-spine/index.server");
    const a = await recordInbound(db, input(`SM${tag}a`, "is room 4 open?"));
    const b = await recordInbound(db, input(`SM${tag}b`, "can I tour tomorrow"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.threadId).toBe(b.threadId);
    expect(a.label).toBe("5259 Spine Ave NE · Room 4");
    const dup = await recordInbound(db, input(`SM${tag}b`, "can I tour tomorrow"));
    expect(dup.ok && dup.duplicate).toBe(true);
    const threads = await db.from("portal_inbox_thread_records").select("id, row_data, workspace_id, conversation_key").eq("owner_user_id", ownerId).like("id", "sms_notice_%");
    expect(threads.data).toHaveLength(1);
    const row = threads.data[0];
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.row_data.prospectContext).toMatchObject({ propertyId, roomLabel: "Room 4", label: "5259 Spine Ave NE · Room 4" });
    const turns = [row.row_data.rootMessageId, ...(row.row_data.messages ?? []).map((m: any) => m.id)];
    expect(turns).toHaveLength(2);
    const ctx = await db.from("prospect_contexts").select("message_count, property_id, room_id").eq("workspace_id", workspaceId);
    expect(ctx.data).toHaveLength(1);
    expect(ctx.data[0]).toMatchObject({ message_count: 2, property_id: propertyId, room_id: "r4" });
  });

  it("the staff who run the service workspace see the house-less-or-tagged thread; a stranger does not", async () => {
    const { resolveCommunicationScope, filterVisibleInboxThreadRecords } = await import("@/lib/communication/conversation-visibility.server");
    const rows = (await db.from("portal_inbox_thread_records").select("id, owner_user_id, participant_email, thread_type, workspace_id, row_data").eq("owner_user_id", ownerId)).data;
    const staffScope = await resolveCommunicationScope(db, staffId, "read", { selectedWorkspaceId: workspaceId });
    expect(staffScope.staffWorkspaceOwners?.get(workspaceId)).toBe(ownerId);
    expect((await filterVisibleInboxThreadRecords(db, staffScope, rows)).length).toBe(rows.length);
    const strangerScope = await resolveCommunicationScope(db, strangerId, "read", { selectedWorkspaceId: null });
    expect((await filterVisibleInboxThreadRecords(db, strangerScope, rows)).length).toBe(0);
    // A thread with NO house (a text that named nothing) is still the staff's.
    const { recordInbound } = await import("@/lib/prospect-spine/index.server");
    const stranger = `+1206${String(Math.floor(2000000 + Math.random() * 7000000))}`;
    created.phones.push(stranger);
    const res = await recordInbound(db, { ...input(`SM${tag}c`, "hello, any rooms?"), identity: { kind: "phone", phoneE164: stranger, verified: false }, context: { propertyId: null, source: "sms" } });
    expect(res.ok).toBe(true);
    const all = (await db.from("portal_inbox_thread_records").select("id, owner_user_id, participant_email, thread_type, workspace_id, row_data").eq("owner_user_id", ownerId)).data;
    const visible = await filterVisibleInboxThreadRecords(db, staffScope, all);
    expect(visible.length).toBe(2);
  });

  it("a delivery issue is stamped with its reason and cleared by a later delivered send", async () => {
    const { recordDeliveryIssue, clearDeliveryIssue } = await import("@/lib/prospect-spine/index.server");
    const { data } = await db.from("portal_inbox_thread_records").select("id").eq("owner_user_id", ownerId).like("id", "sms_notice_%").limit(1);
    const threadId = data[0].id;
    await recordDeliveryIssue(db, { threadId, workspaceId, direction: "outbound", reason: "Not enough text credit for +12065550101", eventId: `ev-${tag}` });
    let row = (await db.from("portal_inbox_thread_records").select("row_data").eq("id", threadId).single()).data.row_data;
    expect(row.deliveryIssue).toMatchObject({ direction: "outbound" });
    expect(row.deliveryIssue.reason).not.toMatch(/\d{7,}/);
    await clearDeliveryIssue(db, threadId);
    row = (await db.from("portal_inbox_thread_records").select("row_data").eq("id", threadId).single()).data.row_data;
    expect(row.deliveryIssue).toBeUndefined();
  });

  it("links an account only on a VERIFIED phone, once, and the manager still sees one thread", async () => {
    const { linkAccountToProspectRecord } = await import("@/lib/prospect-spine/index.server");
    const unverifiedId = await makeUser("unverified", "resident", PROSPECT, false);
    expect(await linkAccountToProspectRecord(db, { userId: unverifiedId, phoneE164: PROSPECT })).toEqual({ linked: false, threads: 0 });
    expect((await db.from("sms_phone_contacts").select("user_id").eq("phone_e164", PROSPECT).single()).data.user_id).toBeNull();
    // the unverified profile still holds the number as a claim; verify it and drop the claim holder
    await db.from("profiles").update({ phone: null, phone_verified_at: null }).eq("id", unverifiedId);
    const verifiedId = await makeUser("verified", "resident", PROSPECT, true);
    const first = await linkAccountToProspectRecord(db, { userId: verifiedId, phoneE164: PROSPECT });
    expect(first.linked).toBe(true);
    expect(first.threads).toBe(1);
    const second = await linkAccountToProspectRecord(db, { userId: verifiedId, phoneE164: PROSPECT });
    expect(second.linked).toBe(true);
    expect((await db.from("sms_phone_contacts").select("user_id, verified_at, linked_at").eq("phone_e164", PROSPECT).single()).data).toMatchObject({ user_id: verifiedId });
    const mirror = await db.from("portal_inbox_thread_records").select("id, row_data").eq("owner_user_id", verifiedId);
    expect(mirror.data).toHaveLength(1);
    const turns = [mirror.data[0].row_data.rootMessageId, ...(mirror.data[0].row_data.messages ?? []).map((m: any) => m.id)];
    expect(turns).toHaveLength(2);
    const managerThreads = await db.from("portal_inbox_thread_records").select("id").eq("owner_user_id", ownerId).like("id", "sms_notice_%");
    expect(managerThreads.data!.length).toBeGreaterThanOrEqual(1);
    const forPhone = await db.from("portal_inbox_thread_records").select("id, row_data").eq("owner_user_id", ownerId).eq("row_data->>prospectPhoneKey", PROSPECT.slice(-10));
    expect(forPhone.data).toHaveLength(1);
  });

  it("a platform inquiry merges into the phone thread by stitch code: one visible thread, MOVED, unverified", async () => {
    const { recordInbound, mintStitchCode, stitchByCode } = await import("@/lib/prospect-spine/index.server");
    const lead = await recordInbound(db, {
      workspaceId, ownerUserId: ownerId,
      identity: { kind: "handle", contactHandle: `h-${tag}`, site: "spareroom", displayName: "Maya" },
      context: { propertyId, roomId: "r4", source: "spareroom" }, body: "Is the room still available?", channel: "email",
      eventId: `mail:${tag}`, occurredAt: new Date().toISOString(), notify: false,
    });
    expect(lead.ok).toBe(true);
    if (!lead.ok) return;
    expect(lead.label).toBe("SpareRoom · 5259 Spine Ave NE Room 4");
    const code = await mintStitchCode(db, lead.contextId);
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    expect(await mintStitchCode(db, lead.contextId)).toBe(code);
    expect(await stitchByCode(db, { code: "ZZZZZ", phoneE164: `+1206${digits}`, workspaceId })).toEqual({ ok: false, reason: "unknown_code" });
    const phone = `+1206${String(Math.floor(2000000 + Math.random() * 7000000))}`;
    created.phones.push(phone);
    const stitched = await stitchByCode(db, { code: code!, phoneE164: phone, workspaceId });
    expect(stitched.ok).toBe(true);
    const rows = await db.from("portal_inbox_thread_records").select("id, row_data").eq("owner_user_id", ownerId).eq("row_data->>prospectPhoneKey", phone.slice(-10));
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0].row_data.platformState).toMatchObject({ site: "spareroom", state: "moved" });
    const contact = await db.from("sms_phone_contacts").select("verified_at, user_id").eq("phone_e164", phone).single();
    expect(contact.data).toMatchObject({ verified_at: null, user_id: null });
    const ctx = await db.from("prospect_contexts").select("channel_state").eq("id", lead.contextId).single();
    expect(ctx.data.channel_state).toBe("moved");
  });
});

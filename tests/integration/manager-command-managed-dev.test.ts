/* eslint-disable @typescript-eslint/no-explicit-any -- rows from a real PostgREST client */
// Manager price-by-text on a PropLane-managed workspace, against the DEV/TEST project only (emstjswhotsnyksqhqyf):
//   MANAGED_CMD_DEV=1 npx vitest run tests/integration/manager-command-managed-dev.test.ts
// Admin-OWNED managed workspace (the new ownership model: owner = service owner, client = Property owner). A staff seat
// (house_scope = all) and the admin-owner both: text -> preview + 4-digit code -> YES <code> -> the listing carries the new
// price (DB row and the public listing page when MANAGED_CMD_BASE_URL is set). Everything created is deleted afterwards.
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

config({ path: ".env.local" });
const DEV_REF = "emstjswhotsnyksqhqyf";
const enabled = process.env.MANAGED_CMD_DEV === "1" && (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(DEV_REF);
const suite = enabled ? describe : describe.skip;

suite("manager price command on an admin-owned managed workspace (dev project)", () => {
  const tag = randomUUID().slice(0, 8);
  const created = { users: [] as string[], workspace: "", property: `mgrcmd-${tag}` };
  let db: any;
  let adminId = "";
  let staffId = "";
  let workspaceId = "";
  const phone = (n: number) => `+1206${String(5550000 + n).padStart(7, "0")}`;
  const adminPhone = phone(Math.floor(Math.random() * 400) + 300);
  const staffPhone = phone(Math.floor(Math.random() * 400) + 700);

  async function makeUser(label: string, role: string, roles: string[], phoneE164: string): Promise<string> {
    const email = `mgrcmd-${tag}-${label}@proplane-test.invalid`;
    const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("user not created");
    created.users.push(data.user.id);
    await db.from("profiles").upsert({ id: data.user.id, role, email, full_name: `Cmd ${label}`, phone: phoneE164, phone_verified_at: new Date().toISOString() }, { onConflict: "id" });
    for (const r of roles) await db.from("profile_roles").upsert({ user_id: data.user.id, role: r }, { onConflict: "user_id,role" });
    return data.user.id;
  }

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    adminId = await makeUser("admin", "admin", ["admin", "manager"], adminPhone);
    staffId = await makeUser("staff", "manager", ["manager"], staffPhone);
    const ins = await db.from("portal_workspaces").insert({ name: `MgrCmd ${tag}`, owner_user_id: adminId, is_service: true, is_default: false }).select("id").single();
    if (ins.error) throw ins.error;
    workspaceId = ins.data.id;
    created.workspace = workspaceId;
    const { createNewListingWizardSubmission, emptyRoom } = await import("@/lib/manager-listing-submission");
    const submission = {
      ...createNewListingWizardSubmission(),
      address: `9100 Cmd ${tag} Ave NE`, buildingName: `Cmd House ${tag}`,
      rooms: [{ ...emptyRoom(0), id: "r1", monthlyRent: 900 }, { ...emptyRoom(1), id: "r2", monthlyRent: 1000 }],
    };
    const prop = await db.from("manager_property_records").insert({
      id: created.property, status: "live", manager_user_id: adminId, workspace_id: workspaceId,
      row_data: { buildingName: submission.buildingName, address: submission.address, submission },
      property_data: { buildingName: submission.buildingName, address: submission.address, listingSubmission: submission },
    });
    if (prop.error) throw prop.error;
    const seat = await db.from("account_link_invites").insert({
      inviter_user_id: adminId, invitee_user_id: staffId, inviter_axis_id: `AX-${tag}`, tab_kind: "manager", status: "accepted",
      workspace_id: workspaceId, team_role: "property_manager", house_scope: "all", is_service_seat: true, assigned_property_ids: [],
    });
    if (seat.error) throw seat.error;
  });

  afterAll(async () => {
    if (!db) return;
    const ids = created.users.filter(Boolean);
    await db.from("agent_pending_actions").delete().in("user_id", ids);
    await db.from("agent_sessions").delete().in("actor_user_id", ids).then(() => undefined, () => undefined);
    await db.from("account_link_invites").delete().eq("workspace_id", workspaceId);
    await db.from("manager_property_records").delete().eq("id", created.property);
    await db.from("portal_workspaces").delete().eq("id", workspaceId);
    for (const id of ids) {
      await db.from("profile_roles").delete().eq("user_id", id);
      await db.from("profiles").delete().eq("id", id);
      await db.auth.admin.deleteUser(id);
    }
  });

  async function roomRent(name: string): Promise<number | null> {
    const { data } = await db.from("manager_property_records").select("property_data").eq("id", created.property).single();
    const rooms = data?.property_data?.listingSubmission?.rooms ?? [];
    return rooms.find((r: any) => r.name === name)?.monthlyRent ?? null;
  }

  async function priceFlow(actorId: string, actorPhone: string, newRent: number) {
    const { handleManagerSmsCommand } = await import("@/lib/manager-sms-commands/index.server");
    const { buildCommandContext } = await import("@/lib/manager-sms-commands/context.server");
    const { runManagerSmsAgentTurn } = await import("@/lib/agent/manager-sms-agent.server");
    const preview = await handleManagerSmsCommand(db, {
      staffPhoneE164: actorPhone, actorUserId: actorId, workspaceIds: [workspaceId],
      body: `change Room 2 at 9100 Cmd ${tag} Ave NE to ${newRent}`, messageSid: `SM${tag}${newRent}`, mediaCount: 0, onPropLaneLine: true,
    });
    expect(preview.handled).toBe(true);
    const reply = preview.handled ? preview.reply : "";
    expect(reply).not.toMatch(/belongs to this landlord|could not find that house|can not do that/i);
    const code = /\b(\d{4})\b/.exec(reply.replace(/\$[\d,]+/g, ""))?.[1];
    expect(code, reply).toBeTruthy();
    // Still behind the code: the price has not moved yet.
    expect(await roomRent("Room 2")).not.toBe(newRent);
    const ctx = await buildCommandContext(db, { actorUserId: actorId, workspaceId });
    expect(ctx).not.toBeNull();
    const turn = await runManagerSmsAgentTurn(db, { ctx: ctx!, managerPhoneE164: actorPhone, inboundText: `YES ${code}`, inboundMessageSid: `SMY${tag}${newRent}`, requireConfirmationCode: true });
    expect(turn?.reply ?? "", turn?.reply).toMatch(/Updated Room 2/i);
    expect(await roomRent("Room 2")).toBe(newRent);
  }

  it("a staff seat (house_scope all) previews and confirms a price change on the admin-owned workspace", async () => {
    await priceFlow(staffId, staffPhone, 1150);
  });

  it("the admin who OWNS the managed workspace does the same (no longer 'view-only null')", async () => {
    await priceFlow(adminId, adminPhone, 1250);
  });

  it("never cross-workspace: a command scoped to a workspace the phone may not run finds nothing", async () => {
    const { handleManagerSmsCommand } = await import("@/lib/manager-sms-commands/index.server");
    const res = await handleManagerSmsCommand(db, {
      staffPhoneE164: staffPhone, actorUserId: staffId, workspaceIds: [randomUUID()],
      body: `change Room 2 at 9100 Cmd ${tag} Ave NE to 5000`, messageSid: `SMX${tag}`, mediaCount: 0, onPropLaneLine: true,
    });
    expect(res.handled && /\b\d{4}\b/.test(res.reply.replace(/\$[\d,]+/g, ""))).toBe(false);
    expect(await roomRent("Room 2")).not.toBe(5000);
  });

  it("the public listing page shows the new price", async () => {
    const base = process.env.MANAGED_CMD_BASE_URL;
    if (!base) return;
    const res = await fetch(`${base}/api/public/property-lead?propertyId=${created.property}`);
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(200);
    expect(text).toMatch(/"monthlyRent":1250/);
  });
});

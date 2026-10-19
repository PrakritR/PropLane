/**
 * Dev-only fixture for the owner portal browser proof (docs/agents/one-number.md, W21).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/seed-owner-portal-proof.ts
 *
 * Refuses to run unless the Supabase project is the dev/test one and the Stripe key is a test key. Idempotent on its fixed ids:
 * it makes one owner-only login who is Property owner of record in TWO workspaces (one PropLane-managed with a signed 90/10 fee
 * policy, one plain), their houses with rooms, rent profiles, a few services, upcoming inspections, a captured rent payment and a
 * vendor bill that waits for the owner's approval. Prints the owner login at the end.
 */
import Stripe from "stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { attestPolicy, createDraftPolicy, loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";
import { creditManagedCapture } from "@/lib/managed-finance/capture.server";
import { gateAndPostManagedVendorBill } from "@/lib/managed-finance/vendor-bills.server";

const DEV_PROJECT = "emstjswhotsnyksqhqyf";
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(DEV_PROJECT)) throw new Error("Refusing to run: not the dev/test project.");
const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
if (!stripeKey.startsWith("sk_test_")) throw new Error("Refusing to run: STRIPE_SECRET_KEY is not a test key.");

const stripe = new Stripe(stripeKey);
const db = createSupabaseServiceRoleClient();

const OWNER_EMAIL = "owner.w21@test.proplane.local";
const OWNER_PASSWORD = "Owner-W21-proof-2026!";
const MANAGER_EMAIL = "manager.w21@test.proplane.local";
const VENDOR_EMAIL = "vendor.w21@test.proplane.local";
const ON = { read: true };
const OWNER_KEYS = { ownerPerformance: ON, ownerStatements: ON, ownerDocuments: ON, ownerMessages: ON };

async function ensureUser(email: string, name: string, role: string, password: string): Promise<string> {
  const found = await db.from("profiles").select("id").eq("email", email).maybeSingle();
  let id = found.data?.id ? String(found.data.id) : "";
  if (!id) {
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    id = data.user.id;
  } else {
    await db.auth.admin.updateUserById(id, { password, email_confirm: true });
  }
  await db.from("profiles").upsert({ id, email, full_name: name, role }, { onConflict: "id" });
  await db.from("profile_roles").upsert({ user_id: id, role }, { onConflict: "user_id,role" });
  return id;
}

async function ensureWorkspace(ownerUserId: string, name: string): Promise<string> {
  const found = await db.from("portal_workspaces").select("id").eq("owner_user_id", ownerUserId).eq("name", name).maybeSingle();
  if (found.data?.id) return String(found.data.id);
  const { data, error } = await db.from("portal_workspaces").insert({ owner_user_id: ownerUserId, name }).select("id").single();
  if (error || !data) throw new Error(`workspace ${name}: ${error?.message}`);
  return String(data.id);
}

async function ensureHouse(args: { id: string; manager: string; workspaceId: string; name: string; address: string; rooms: { label: string; rent: number; resident: string | null }[] }) {
  const submission = {
    buildingName: args.name,
    address: args.address,
    rooms: args.rooms.map((r, i) => ({ id: `${args.id}-room-${i + 1}`, name: r.label, monthlyRent: r.rent })),
  };
  const property = { id: args.id, buildingName: args.name, title: args.name, address: args.address, managerUserId: args.manager, listingSubmission: submission };
  const { error } = await db.from("manager_property_records").upsert(
    { id: args.id, manager_user_id: args.manager, workspace_id: args.workspaceId, status: "live", row_data: { id: args.id, buildingName: args.name, address: args.address, submission }, property_data: property },
    { onConflict: "id" },
  );
  if (error) throw new Error(`house ${args.id}: ${error.message}`);
  for (const [i, room] of args.rooms.entries()) {
    const rid = `${args.id}-rrp-${i + 1}`;
    // A vacant room still counts as a unit: a profile that starts far in the future gives the report a unit with 0 days rented.
    const rowData = {
      id: rid, active: true, dueDay: 1, roomLabel: room.label, propertyId: args.id, propertyLabel: args.name,
      startMonth: room.resident ? "2026-05" : "2030-01", monthlyRent: room.rent, managerUserId: args.manager,
      ...(room.resident ? { residentName: room.resident, leaseEnd: "2027-04-30" } : {}),
    };
    const { error: rrpErr } = await db.from("portal_recurring_rent_profile_records").upsert(
      { id: rid, manager_user_id: args.manager, property_id: args.id, active: true, resident_email: room.resident ? `${rid}@test.proplane.local` : null, row_data: rowData },
      { onConflict: "id" },
    );
    if (rrpErr) throw new Error(`rent profile ${rid}: ${rrpErr.message}`);
  }
}

async function main() {
  const manager = await ensureUser(MANAGER_EMAIL, "W21 Manager", "manager", "Manager-W21-proof-2026!");
  const owner = await ensureUser(OWNER_EMAIL, "Dana Whitfield", "manager", OWNER_PASSWORD);
  const vendor = await ensureUser(VENDOR_EMAIL, "W21 Plumbing", "vendor", "Vendor-W21-proof-2026!");
  const wsA = await ensureWorkspace(manager, "Alder Row Homes");
  const wsB = await ensureWorkspace(manager, "Lakeview Rentals");
  const A1 = "w21-alder-row";
  const A2 = "w21-maple-court";
  const B1 = "w21-lakeview-duplex";
  await ensureHouse({ id: A1, manager, workspaceId: wsA, name: "Alder Row", address: "4120 Alder St, Seattle, WA 98118", rooms: [{ label: "Room 1", rent: 1050, resident: "Resident One" }, { label: "Room 2", rent: 1100, resident: "Resident Two" }, { label: "Room 3", rent: 1050, resident: null }] });
  await ensureHouse({ id: A2, manager, workspaceId: wsA, name: "Maple Court", address: "812 Maple Ave, Seattle, WA 98122", rooms: [{ label: "Room 1", rent: 1200, resident: "Resident Three" }, { label: "Room 2", rent: 1200, resident: "Resident Four" }] });
  await ensureHouse({ id: B1, manager, workspaceId: wsB, name: "Lakeview Duplex", address: "77 Lake Washington Blvd, Seattle, WA 98144", rooms: [{ label: "Unit A", rent: 2100, resident: "Resident Five" }, { label: "Unit B", rent: 2000, resident: null }] });

  for (const [ws, ids] of [[wsA, [A1, A2]], [wsB, [B1]]] as const) {
    const existing = await db.from("account_link_invites").select("id").eq("invitee_user_id", owner).eq("workspace_id", ws).eq("team_role", "property_owner").maybeSingle();
    const perms = Object.fromEntries(ids.map((id) => [id, OWNER_KEYS]));
    const values = {
      inviter_user_id: manager, invitee_user_id: owner, tab_kind: "manager", inviter_axis_id: `w21-m-${ws.slice(0, 6)}`, invitee_axis_id: `w21-o-${ws.slice(0, 6)}`,
      status: "accepted", workspace_id: ws, team_role: "property_owner", house_scope: "selected", assigned_property_ids: ids, property_co_manager_permissions: perms,
    };
    if (existing.data?.id) await db.from("account_link_invites").update(values).eq("id", existing.data.id);
    else {
      const { error } = await db.from("account_link_invites").insert(values);
      if (error) throw new Error(`invite: ${error.message}`);
    }
  }

  // Managed fee policy on workspace A, signed.
  let policy = await loadActivePolicyForWorkspace(db, wsA);
  if (!policy) {
    const admin = { role: "admin" as const, userId: manager };
    const draft = await createDraftPolicy(db, admin, {
      workspaceId: wsA, ownerUserId: owner, effectiveFrom: "2026-01-01",
      terms: { ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0, repairApprovalThresholdCents: 50_000 },
    });
    policy = await attestPolicy(db, admin, draft.id, "W21 proof contract (test)");
  }

  // Rent captured on the platform balance this month, allocated 90/10 per house.
  const stamp = new Date().toISOString().slice(0, 7);
  for (const [propertyId, cents] of [[A1, 215_000], [A2, 240_000]] as const) {
    // Re-running adds another capture; set SKIP_CAPTURE=1 to refresh the other fixtures only.
    if (process.env.SKIP_CAPTURE === "1") continue;
    const pi = await stripe.paymentIntents.create({
      amount: cents, currency: "usd", payment_method: "pm_card_bypassPending", confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { proof: `w21-${stamp}-${propertyId}` },
    });
    const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge!.id;
    const components = [{ id: `w21-charge-${propertyId}-${stamp}`, kind: "rent", liabilityClass: "income" as const, principalCents: cents, recipientNetCents: cents, propertyId, residentEmail: "resident@example.test", paidAt: new Date().toISOString() }];
    const credited = await creditManagedCapture(db, stripe, { policy, paymentIntentId: pi.id, stripeChargeId: chargeId, grossCents: cents, components });
    console.log("capture", propertyId, credited.status);
  }

  // A small repair that posts (under the threshold) and a larger one that waits for the owner's approval.
  await gateAndPostManagedVendorBill(db, { workspaceId: wsA, vendorUserId: vendor, amountCents: 24_000, title: "Kitchen sink leak", vendorLabel: "W21 Plumbing", propertyId: A1, sourceType: "manual", sourceId: "w21-bill-leak" }).catch((e) => console.log("bill 1:", e?.message));
  await gateAndPostManagedVendorBill(db, { workspaceId: wsA, vendorUserId: vendor, amountCents: 86_000, title: "Water heater replacement", vendorLabel: "W21 Plumbing", propertyId: A2, sourceType: "manual", sourceId: "w21-bill-heater" }).catch((e) => console.log("bill 2:", e?.message));

  // Services history (read by the house page): stored work orders.
  const services = [
    { id: "w21-wo-1", pid: A1, title: "Kitchen sink leak", bucket: "completed", scheduled: "Oct 6, 2026", cost: "$240" },
    { id: "w21-wo-2", pid: A1, title: "Replace smoke detector batteries", bucket: "scheduled", scheduled: "Oct 22, 2026", cost: "$45" },
    { id: "w21-wo-3", pid: A2, title: "Water heater replacement", bucket: "open", scheduled: "", cost: "$860" },
  ];
  for (const s of services) {
    const { error } = await db.from("portal_work_order_records").upsert(
      { id: s.id, manager_user_id: manager, property_id: s.pid, row_data: { id: s.id, propertyId: s.pid, propertyName: s.pid === A1 ? "Alder Row" : "Maple Court", unit: "Room 1", title: s.title, priority: "normal", status: s.bucket, bucket: s.bucket, description: "", scheduled: s.scheduled, cost: s.cost, managerUserId: manager } },
      { onConflict: "id" },
    );
    if (error) console.log("service:", error.message);
  }

  // Upcoming move-ins / inspections within the next two weeks.
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const inspections = [
    { id: "00000000-0000-4000-8000-000000002101", app: "w21-app-1", pid: A1, label: "Alder Row", room: "Room 3", kind: "move-in", date: day(5) },
    { id: "00000000-0000-4000-8000-000000002102", app: "w21-app-2", pid: A2, label: "Maple Court", room: "Room 2", kind: "move-out", date: day(11) },
  ];
  for (const i of inspections) {
    const { error } = await db.from("resident_inspections").upsert(
      { id: i.id, application_id: i.app, manager_user_id: manager, property_id: i.pid, resident_email: `${i.app}@test.proplane.local`, resident_name: "Resident", property_label: i.label, room_label: i.room, kind: i.kind, status: "draft", inspection_date: i.date, document: {} },
      { onConflict: "id" },
    );
    if (error) console.log("inspection:", error.message);
  }

  console.log(JSON.stringify({ ownerEmail: OWNER_EMAIL, ownerPassword: OWNER_PASSWORD, owner, manager, workspaces: { managed: wsA, plain: wsB }, houses: [A1, A2, B1] }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

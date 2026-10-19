/**
 * Throwaway dev fixtures for the scenario harness. Everything is created fresh per run under a unique run id
 * (+1206555 01xx numbers, e2e-<run> emails and ids) and removed by cleanup.mjs.
 */
import { hex, uuid } from "./core.mjs";

const NOW = () => new Date().toISOString();

const TRANSIENT = /statement timeout|timeout|fetch failed|ECONNRESET|socket|503|502|temporarily/i;

/** Await a PostgREST call, retrying transient failures (the shared dev database is busy). `make` builds a fresh query each try. */
async function must(make, label) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await (typeof make === "function" ? make() : make);
    if (!error) return data;
    last = error;
    if (!TRANSIENT.test(error.message ?? "")) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`${label}: ${last?.message}`);
}

export class World {
  constructor(db, runId) {
    this.db = db;
    this.runId = runId;
    this.userIds = [];
    this.ownerIds = [];
    this.workspaceIds = [];
    this.houseIds = [];
    this.phones = [];
    this.next = 60 + Math.floor(Math.random() * 20);
  }

  /** A fixture phone: +1206555 01nn (reserved fictional range), unique within the run. */
  phone() {
    const p = `+1206555${String(100 + this.next++).padStart(4, "0")}`;
    this.phones.push(p);
    return p;
  }

  async createUser({ label, role, phone = null, fullName }) {
    const email = `e2e-${this.runId}-${label}@proplane-e2e.test`;
    let data = null;
    for (let attempt = 0; attempt < 5 && !data; attempt += 1) {
      const res = await this.db.auth.admin.createUser({ email, password: `E2e-${hex(12)}!`, email_confirm: true, user_metadata: { role } });
      if (!res.error) { data = res.data; break; }
      // A timed-out create may have landed: find it by email before trying again.
      for (let page = 1; page < 30 && !data; page += 1) {
        const list = await this.db.auth.admin.listUsers({ page, perPage: 200 });
        const hit = list.data?.users?.find((u) => u.email === email);
        if (hit) data = { user: hit };
        if ((list.data?.users?.length ?? 0) < 200) break;
      }
      if (!data) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    if (!data) throw new Error(`createUser ${email}: failed after retries`);
    const id = data.user.id;
    this.userIds.push(id);
    await must(() => this.db.from("profiles").upsert({ id, email, role, full_name: fullName ?? label, manager_id: role === "manager" ? `MGR-E2E${hex(8).toUpperCase()}` : null }, { onConflict: "id" }), `profile ${label}`);
    await must(() => this.db.from("profile_roles").upsert({ user_id: id, role }, { onConflict: "user_id,role" }), `role ${label}`);
    if (role === "manager") {
      this.ownerIds.push(id);
      // Paid tier (an admin-assigned plan, so it is not read as a signup trial): the workspace's included communication credit pays for agent turns and replies.
      const { data: prof } = await this.db.from("profiles").select("manager_id").eq("id", id).maybeSingle();
      await must(() => this.db.from("manager_purchases").insert({ email, user_id: id, manager_id: prof?.manager_id ?? `MGR-E2E${hex(8)}`, stripe_checkout_session_id: `e2e_${this.runId}_${label}`, tier: "business", billing: "admin", paid_at: NOW() }), `purchase ${label}`);
    }
    if (phone) {
      await must(() => this.db.from("profiles").update({ phone, phone_verified_at: NOW() }).eq("id", id), `phone ${label}`);
      this.phones.push(phone);
    }
    return { id, email, phone, label };
  }

  async createWorkspace({ ownerId, name }) {
    const rows = await must(() => this.db.from("portal_workspaces").insert({ owner_user_id: ownerId, name, is_default: true }).select("id"), `workspace ${name}`);
    this.workspaceIds.push(rows[0].id);
    return rows[0].id;
  }

  /** A live house with two priced rooms, https photos, in `workspaceId`. */
  async createHouse({ ownerId, workspaceId, name, street, rents = [900, 1000] }) {
    const id = `e2e-${this.runId}-${hex(6)}`;
    const address = `${street}, Seattle, WA 98107`;
    const rooms = rents.map((rent, i) => ({
      id: `${id}-r${i + 1}`, name: `Room ${String.fromCharCode(65 + i)}`, floor: "2", monthlyRent: rent, occupancyCapacity: 1,
      availability: "Now", moveInAvailableDate: "2026-10-01", manualUnavailableRanges: [], detail: "Sunny room with a desk",
      furnishing: "Furnished", roomAmenitiesText: "Desk", utilitiesEstimate: "60", utilitiesPaymentModel: "manager_billed", securityDeposit: "500",
      photoDataUrls: [`https://images.proplane-e2e.test/${id}/room-${i + 1}.jpg`], videoDataUrl: null,
    }));
    const submission = {
      v: 1, buildingName: name, address, zip: "98107", neighborhood: "Ballard", homeStructureNote: "", tagline: "Bright house near transit",
      petFriendly: false, houseOverview: "A quiet shared house in Ballard.", marketingNotes: "", houseRulesText: "", amenitiesText: "Laundry",
      housePhotoDataUrls: [`https://images.proplane-e2e.test/${id}/house.jpg`], leaseTermsBody: "12-Month", allowedLeaseTerms: ["12-Month"],
      shortTermRentalsAllowed: false, applicationFee: "45", securityDeposit: "500", moveInFee: "100", paymentAtSigningIncludes: [], houseCostsDetail: "",
      parkingMonthly: "0", hoaMonthly: "0", otherMonthlyFees: "0", quickFacts: [], bundles: [], sharedSpaces: [], rooms,
      bathrooms: [{ id: `${id}-bath1`, name: "Private bath", location: "Second floor", amenitiesText: "", photoDataUrls: [], shower: true, toilet: true, bathtub: false, sink: true, mirror: true, assignedRoomIds: [rooms[0].id], allResidents: false }],
    };
    const property = {
      id, title: name, tagline: "Bright house near transit", address, zip: "98107", neighborhood: "Ballard", beds: rooms.length, baths: 1,
      rentLabel: `$${Math.min(...rents)} / mo`, available: "Now", petFriendly: false, buildingId: `${id}-bld`, buildingName: name,
      unitLabel: `${rooms.length} rooms`, mapLat: 47.668, mapLng: -122.384, managerUserId: ownerId, adminPublishLive: true, listingSubmission: submission,
    };
    await must(() => this.db.from("manager_property_records").upsert({
      id, manager_user_id: ownerId, workspace_id: workspaceId, status: "live", property_data: property,
      row_data: { id, status: "live", name, buildingName: name, address, testRunId: this.runId },
    }, { onConflict: "id" }), `house ${name}`);
    this.houseIds.push(id);
    return { id, name, address, rooms, workspaceId, ownerId };
  }

  /** Open tour slots (Pacific wall time, 9:00-17:00, Mon-Sat) for the next three weeks on one house. */
  async paintTourAvailability({ ownerId, houseId }) {
    const id = `axis_mgr_avail_slots_v2_${ownerId}_prop_${houseId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
    const keys = [];
    const day = new Date();
    for (let i = 0; i < 21; i += 1) {
      const d = new Date(day.getTime() + i * 86400000);
      const ds = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(d);
      if (weekday === "Sun") continue;
      for (let slot = 18; slot < 34; slot += 1) keys.push(`${ds}:${slot}`);
    }
    await must(() => this.db.from("portal_schedule_records").upsert({
      id, manager_user_id: ownerId, property_id: houseId, record_type: "manager_property_availability",
      row_data: { id, recordType: "manager_property_availability", managerUserId: ownerId, propertyId: houseId, payload: keys }, updated_at: NOW(),
    }, { onConflict: "id" }), "tour availability");
  }

  /** An approved resident in a room of `house`, with a verified phone, a rent charge due soon and (optionally) an overdue one. */
  async createResident({ ownerId, house, roomIndex = 1, label = "res", phone, fullName = "Riley Resident", overdue = false }) {
    const user = await this.createUser({ label, role: "resident", phone, fullName });
    const room = house.rooms[roomIndex];
    const applicationId = `e2e-app-${this.runId}-${label}`;
    await must(() => this.db.from("manager_application_records").upsert({
      id: applicationId, manager_user_id: ownerId, resident_email: user.email, property_id: house.id, assigned_property_id: house.id,
      row_data: { id: applicationId, axisId: applicationId, bucket: "approved", stage: "Approved", email: user.email, name: fullName, property: house.name, propertyId: house.id, assignedPropertyId: house.id, assignedRoomChoice: room.name, managerUserId: ownerId, testRunId: this.runId, application: { propertyId: house.id, roomChoice1: room.name } },
      occupancy_start: new Date().toISOString().slice(0, 10),
    }, { onConflict: "id" }), `application ${label}`);
    await must(() => this.db.from("resident_workspace_bindings").upsert({ resident_user_id: user.id, manager_user_id: ownerId, application_id: applicationId }, { onConflict: "resident_user_id,manager_user_id" }), `binding ${label}`);
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const label2 = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const charges = [{ id: `e2e-chg-${this.runId}-${label}-now`, title: "October rent", due: day(5), amount: room.monthlyRent }];
    if (overdue) charges.push({ id: `e2e-chg-${this.runId}-${label}-late`, title: "September rent", due: day(-18), amount: room.monthlyRent });
    for (const c of charges) {
      const money = `$${Number(c.amount).toFixed(2)}`;
      await must(() => this.db.from("portal_household_charge_records").upsert({
        id: c.id, manager_user_id: ownerId, resident_user_id: user.id, resident_email: user.email, property_id: house.id, kind: "rent", status: "pending",
        row_data: { id: c.id, createdAt: NOW(), applicationId, residentEmail: user.email, residentName: fullName, residentUserId: user.id, propertyId: house.id, propertyLabel: house.name,
          managerUserId: ownerId, kind: "rent", title: c.title, amountLabel: money, balanceLabel: money, status: "pending", dueDate: c.due, dueDateLabel: label2(c.due), testRunId: this.runId },
      }, { onConflict: "id" }), `charge ${c.id}`);
    }
    return { ...user, applicationId, room, charges };
  }

  /** A vendor on the workspace owner's roster (a phone is all a texting vendor needs). */
  async createRosterVendor({ ownerId, name, trade, phone }) {
    const id = `e2e-vendor-${this.runId}-${hex(5)}`;
    this.phones.push(phone);
    await must(() => this.db.from("manager_vendor_records").upsert({ id, manager_user_id: ownerId, row_data: { id, name, trade, trades: [trade], phone, email: "", notes: "", active: true, testRunId: this.runId } }, { onConflict: "id" }), `vendor ${name}`);
    return { id, name, trade, phone };
  }

  /** A dispatch rule (manager approves first) with `vendors` in chain order. */
  async createDispatchRule({ workspaceId, ownerId, trade, issue, vendors, payCents = 12000, nteCents = 18000 }) {
    const id = uuid();
    await must(() => this.db.from("vendor_dispatch_rules").upsert({
      id, workspace_id: workspaceId, owner_user_id: ownerId, name: `E2E ${issue}`, trade, issue, property_scope: "all", property_ids: [],
      urgencies: ["emergency", "urgent", "routine"], hours: "any", mode: "sequential", broadcast_size: 3, timeout_minutes: null,
      pay_cents: payCents, pay_model: "flat", nte_cents: nteCents, approval: "always", active: true,
    }, { onConflict: "id" }), "dispatch rule");
    for (const [position, v] of vendors.entries()) {
      await must(() => this.db.from("vendor_dispatch_rule_vendors").upsert({ rule_id: id, vendor_directory_id: v.id, position }, { onConflict: "rule_id,vendor_directory_id" }), "rule vendor");
    }
    return id;
  }

  /** The owner of record of a PropLane-managed workspace: a verified phone and an active, signed fee policy. */
  async createOwner({ workspaceId, phone, fullName = "Olive Owner" }) {
    const user = await this.createUser({ label: "owner", role: "manager", phone, fullName });
    await must(() => this.db.from("managed_workspace_fee_policies").insert({
      workspace_id: workspaceId, owner_user_id: user.id, status: "active", owner_share_bps: 9000, applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0,
      reserve_target_cents: 0, repair_approval_threshold_cents: 25000, effective_from: new Date().toISOString().slice(0, 10), sent_at: NOW(), signed_at: NOW(), accepted_via: "attested",
    }), "owner policy");
    return user;
  }
}

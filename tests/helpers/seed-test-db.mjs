#!/usr/bin/env node
/**
 * Seeds a dedicated Supabase test project with admin, manager, resident, and sample data.
 * Usage: node --env-file=.env.test tests/helpers/seed-test-db.mjs [testRunId]
 *
 * Every upsert is error-checked (`must`) so a schema mismatch fails the run loudly
 * instead of silently leaving the test accounts disconnected.
 *
 * Beyond the primary E2E manager/resident/property/charge, this seeds a coherent
 * browse catalog: every home the public browse/apply flow lists is a live
 * `manager_property_records` row OWNED by a test manager (manager@ / manager2@
 * test.proplane.local), carries a full listingSubmission (v:1), and has at least one
 * application (manager_application_records) and one lease
 * (portal_lease_pipeline_records) in its pipeline — no orphaned properties.
 * Approved applicants also receive household charges and signed leases get
 * recurring rent profiles. The primary E2E resident (resident@test) is one of
 * those applicants. Default promotion flyer + text rows are seeded per live
 * manager@test property.
 * Superseded rows from older seeds (seedwf_ / mgr- prefixes, ANY status) owned
 * by the test managers are deleted — a non-live row like a `review` loft still
 * reaches the Calendar property picker (propertyRowsToSnapshot puts review rows
 * in extras) while never reaching the Properties tab (which needs a `mgr-`
 * prefix), so leftovers make tabs disagree. Dependent rows that reference a
 * non-canonical property, calendar events pointing at missing properties, and
 * runtime drift on non-approved applicants are cleaned for the same reason:
 * every tab must show the same coherent catalog.
 *
 * Reference implementation for column names / row shapes:
 * scripts/seed-demo-manager-workflow.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  assertTestProjectUrl,
  DEMO_WORKFLOW_RESIDENT_EMAILS,
  PRODUCTION_ADMIN_EMAIL,
} from "./canonical-test-accounts.mjs";
import {
  CANONICAL_DEMO_PORTFOLIO_PROPERTY_IDS,
  reclaimCanonicalPropertyOwners,
} from "./reclaim-canonical-property-owners.mjs";
import { ensureManagerStripeCustomer, getSeedStripeClient } from "./ensure-stripe-test-customer.mjs";
import { buildSeedLeaseHtml } from "./build-seed-lease-html.mjs";
import {
  buildSeedChargesForPerson,
  buildSeedRentProfileForPerson,
  householdChargeDbRow,
  rentProfileDbRow,
} from "./build-seed-catalog-charges.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testRunId = process.argv[2]?.trim() || `seed-${Date.now()}`;

// `?.trim() ||` (never `??`): CI injects a missing secret as an empty string,
// which must fall back to the same defaults tests/fixtures/index.ts resolves.
const adminEmail = (process.env.E2E_ADMIN_EMAIL?.trim() || "admin@test.proplane.local").toLowerCase();
const adminPassword = process.env.E2E_ADMIN_PASSWORD?.trim() || "TestAdmin123!";
const managerEmail = (process.env.E2E_MANAGER_EMAIL?.trim() || "manager@test.proplane.local").toLowerCase();
const managerPassword = process.env.E2E_MANAGER_PASSWORD?.trim() || "TestManager123!";
const residentEmail = (process.env.E2E_RESIDENT_EMAIL?.trim() || "resident@test.proplane.local").toLowerCase();
const residentPassword = process.env.E2E_RESIDENT_PASSWORD?.trim() || "TestResident123!";
// Must match E2E_RESIDENT_AXIS_ID in tests/fixtures/index.ts. The application
// record id IS the resident's axis id (see normalizeApplicationAxisId), and the
// resident's `profiles.manager_id` stores the same axis id — that is where the
// app reads it (resident-portal-access.ts, resident-profile-panel.tsx).
const residentAxisId = process.env.E2E_RESIDENT_AXIS_ID?.trim() || "AXIS-TESTRSID";
const vendorEmail = (process.env.E2E_VENDOR_EMAIL?.trim() || "vendor@test.proplane.local").toLowerCase();
const vendorPassword = process.env.E2E_VENDOR_PASSWORD?.trim() || "TestVendor123!";
// All-portals sandbox account for manual testing: one login that can open every
// portal (admin + manager + resident + vendor) via the sign-in role picker.
// Matches CANONICAL_DEMO_ADMIN_EMAIL / CANONICAL_DEMO_GUIDED_EMAIL in
// src/lib/demo/demo-canonical-accounts.ts.
const everythingEmail = (process.env.E2E_EVERYTHING_EMAIL?.trim() || "testeverything@test.proplane.local").toLowerCase();
const everythingPassword = process.env.E2E_EVERYTHING_PASSWORD?.trim() || "TestEverything123!";
const EVERYTHING_NAME = "Test Everything";
// Keep in sync with src/lib/demo/demo-canonical-accounts.ts (plain-node script
// can't import the TS module).
const PRIMARY_RESIDENT_NAME = "Test Resident";
const CANONICAL_DEMO_MANAGER_NAME = "Test Manager";
const CANONICAL_DEMO_VENDOR_NAME = "Test Vendor";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
// This seed both creates test accounts and PRUNES non-canonical ones — it must
// only ever touch the dedicated test project, and the production ops admin
// must never be part of the canonical test set.
assertTestProjectUrl(url);
for (const [label, email] of [
  ["E2E_ADMIN_EMAIL", adminEmail],
  ["E2E_MANAGER_EMAIL", managerEmail],
  ["E2E_RESIDENT_EMAIL", residentEmail],
  ["E2E_VENDOR_EMAIL", vendorEmail],
  ["E2E_EVERYTHING_EMAIL", everythingEmail],
]) {
  if (email === PRODUCTION_ADMIN_EMAIL) {
    console.error(`${label} is the production admin (${PRODUCTION_ADMIN_EMAIL}) — that account lives only in production.`);
    process.exit(1);
  }
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = getSeedStripeClient();

/** Throws when a Supabase mutation returned an error — no more silent seed failures. */
async function must(promise, label) {
  const { error, data } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function ensureManagerLandlordProfile(managerUserId, legalName) {
  const name = String(legalName ?? "").trim();
  if (name.length < 2) return;
  const { data: existing } = await supabase
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...existing.row_data }
      : {};
  const profile =
    rowData.landlordProfile && typeof rowData.landlordProfile === "object" && !Array.isArray(rowData.landlordProfile)
      ? rowData.landlordProfile
      : {};
  if (String(profile.landlordLegalName ?? "").trim()) return;
  rowData.landlordProfile = { landlordLegalName: name };
  await must(
    supabase.from("manager_automation_settings").upsert(
      {
        manager_user_id: managerUserId,
        row_data: rowData,
        updated_at: NOW.toISOString(),
      },
      { onConflict: "manager_user_id" },
    ),
    `manager_automation_settings(landlordProfile:${managerUserId})`,
  );
}

const NOW = new Date();
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000);

function startOfWeekMonday(d = NOW) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  const weekday = x.getDay();
  x.setDate(x.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  return x;
}

function slotIsoFromDateStr(dateStr, slotIndex) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const minutes = slotIndex * 30;
  return new Date(y, m - 1, day, Math.floor(minutes / 60), minutes % 60, 0, 0).toISOString();
}

/** Half-hour slot keys (`YYYY-MM-DD:slotIndex`) for tour availability painting. */
function buildTourAvailabilitySlotKeys(weekMonday, { weeks = 2, weekdays = [0, 1, 2, 3, 4, 5], startSlot = 18, endSlotExclusive = 34 } = {}) {
  const keys = [];
  for (let week = 0; week < weeks; week += 1) {
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      if (!weekdays.includes(dayIndex)) continue;
      const d = new Date(weekMonday);
      d.setDate(d.getDate() + week * 7 + dayIndex);
      const ds = isoDate(d);
      for (let slot = startSlot; slot < endSlotExclusive; slot += 1) {
        keys.push(`${ds}:${slot}`);
      }
    }
  }
  return keys;
}

function managerPropertyAvailabilityRecordId(managerUserId, propertyId) {
  const safe = propertyId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return `axis_mgr_avail_slots_v2_${managerUserId}_prop_${safe}`;
}

async function upsertPropertyTourAvailability(managerUserId, propertyId, slotKeys) {
  const id = managerPropertyAvailabilityRecordId(managerUserId, propertyId);
  await must(
    supabase.from("portal_schedule_records").upsert(
      {
        id,
        manager_user_id: managerUserId,
        property_id: propertyId,
        record_type: "manager_property_availability",
        row_data: {
          id,
          recordType: "manager_property_availability",
          managerUserId,
          propertyId,
          payload: slotKeys,
        },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    `portal_schedule_records(avail:${propertyId})`,
  );
}

async function mergeScheduleSingletonPayload(singletonId, recordType, ownerUserId, items) {
  const { data: existing, error } = await supabase
    .from("portal_schedule_records")
    .select("id, row_data, manager_user_id")
    .eq("id", singletonId)
    .maybeSingle();
  if (error) throw new Error(`select ${singletonId}: ${error.message}`);
  const current = Array.isArray(existing?.row_data?.payload) ? existing.row_data.payload : [];
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of items) byId.set(item.id, item);
  await must(
    supabase.from("portal_schedule_records").upsert(
      {
        id: singletonId,
        manager_user_id: existing?.manager_user_id ?? ownerUserId,
        record_type: recordType,
        row_data: {
          id: singletonId,
          recordType,
          managerUserId: existing?.row_data?.managerUserId ?? ownerUserId,
          payload: [...byId.values()],
        },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    `portal_schedule_records(${singletonId})`,
  );
}

async function mergeTourHostRegistry(entries) {
  const registryId = "axis_property_mgr_registry_v1";
  const { data: existing, error } = await supabase
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("id", registryId)
    .maybeSingle();
  if (error) throw new Error(`select ${registryId}: ${error.message}`);
  const current =
    existing?.row_data?.payload && typeof existing.row_data.payload === "object" && !Array.isArray(existing.row_data.payload)
      ? { ...existing.row_data.payload }
      : {};
  for (const { propertyId, userId, label } of entries) {
    const hosts = Array.isArray(current[propertyId]) ? [...current[propertyId]] : [];
    if (!hosts.some((host) => host.userId === userId)) {
      hosts.push({ userId, label, propertyId });
    }
    current[propertyId] = hosts;
  }
  await must(
    supabase.from("portal_schedule_records").upsert(
      {
        id: registryId,
        manager_user_id: null,
        record_type: "axis_property_mgr_registry_v1",
        row_data: {
          id: registryId,
          recordType: "axis_property_mgr_registry_v1",
          payload: current,
        },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    registryId,
  );
}

/**
 * Paint tour availability, register tour hosts, and upsert confirmed + pending
 * tour rows into the calendar singletons the portal sync reads.
 */
async function seedScheduleToursForManager({ managerUserId, hostLabel, properties }) {
  if (!properties.length) return;
  const weekMonday = startOfWeekMonday();
  const availabilitySlotKeys = buildTourAvailabilitySlotKeys(weekMonday);
  const createdAt = NOW.toISOString();

  for (const property of properties) {
    await upsertPropertyTourAvailability(managerUserId, property.id, availabilitySlotKeys);
    await mergeTourHostRegistry([{ propertyId: property.id, userId: managerUserId, label: hostLabel }]);
  }

  const plannedEvents = [];
  const partnerInquiries = [];
  const tourSpecs = [
    {
      plannedId: `seed-planned-${managerUserId.slice(0, 8)}-a`,
      inquiryId: `seed-pending-${managerUserId.slice(0, 8)}-a`,
      property: properties[0],
      daysOut: 2,
      slot: 20,
      guest: { name: "Jamie Rivera", email: "jamie.tour@axis.local", phone: "+12025550111" },
      pendingGuest: { name: "Sam Ortiz", email: "sam.tour@axis.local", phone: "+12025550112" },
    },
    {
      plannedId: `seed-planned-${managerUserId.slice(0, 8)}-b`,
      inquiryId: `seed-pending-${managerUserId.slice(0, 8)}-b`,
      property: properties[1] ?? properties[0],
      daysOut: 4,
      slot: 24,
      guest: { name: "Alex Kim", email: "alex.tour@axis.local", phone: "+12025550113" },
      pendingGuest: { name: "Jordan Lee", email: "jordan.tour@axis.local", phone: "+12025550114" },
    },
  ];

  for (const spec of tourSpecs) {
    const ds = isoDate(daysFromNow(spec.daysOut));
    const slotKey = `${ds}:${spec.slot}`;
    const start = slotIsoFromDateStr(ds, spec.slot);
    const end = slotIsoFromDateStr(ds, spec.slot + 2);

    plannedEvents.push({
      id: spec.plannedId,
      title: `Tour · ${spec.guest.name}`,
      start,
      end,
      kind: "tour",
      managerUserId,
      propertyId: spec.property.id,
      propertyTitle: spec.property.name,
      attendeeName: spec.guest.name,
      attendeeEmail: spec.guest.email,
      attendeePhone: spec.guest.phone,
      slotKey,
    });

    const pendingStart = slotIsoFromDateStr(ds, spec.slot + 4);
    const pendingEnd = slotIsoFromDateStr(ds, spec.slot + 6);
    const pendingSlotKey = `${ds}:${spec.slot + 4}`;
    partnerInquiries.push({
      id: spec.inquiryId,
      name: spec.pendingGuest.name,
      email: spec.pendingGuest.email,
      phone: spec.pendingGuest.phone,
      notes: "Interested in a furnished room with a desk setup.",
      kind: "tour",
      status: "pending",
      managerUserId,
      propertyId: spec.property.id,
      propertyTitle: spec.property.name,
      proposedStart: pendingStart,
      proposedEnd: pendingEnd,
      createdAt,
      tourGroupId: `seed-grp-${spec.inquiryId}`,
      requestedWindows: [{ start: pendingStart, end: pendingEnd, slotKey: pendingSlotKey, adminUserId: managerUserId }],
    });
  }

  await mergeScheduleSingletonPayload(
    "axis_admin_planned_events_v1",
    "axis_admin_planned_events_v1",
    managerUserId,
    plannedEvents,
  );
  await mergeScheduleSingletonPayload(
    "axis_admin_partner_inquiries_v1",
    "axis_admin_partner_inquiries_v1",
    managerUserId,
    partnerInquiries,
  );
}

async function ensureUser(
  email,
  password,
  role,
  { managerId = null, metadata = {}, onlyRole = false, fullName = null } = {},
) {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, ...metadata },
  });

  let userId;
  if (createErr) {
    const exists = createErr.message.toLowerCase().includes("already");
    if (!exists) throw new Error(`createUser ${email}: ${createErr.message}`);
    const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) throw new Error(`listUsers: ${listErr.message}`);
    const existing = listData?.users?.find((u) => u.email?.toLowerCase() === email);
    if (!existing) throw new Error(`User ${email} exists but not found`);
    userId = existing.id;
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password,
      user_metadata: { ...(existing.user_metadata ?? {}), role, ...metadata },
    });
    if (updateErr) throw new Error(`updateUserById ${email}: ${updateErr.message}`);
  } else {
    userId = created.user.id;
  }

  await must(
    supabase.from("profiles").upsert(
      {
        id: userId,
        email,
        role,
        ...(managerId ? { manager_id: managerId } : {}),
        full_name: fullName ?? email.split("@")[0],
      },
      { onConflict: "id" },
    ),
    `profiles(${email})`,
  );

  await must(
    supabase.from("profile_roles").upsert({ user_id: userId, role }, { onConflict: "user_id,role" }),
    `profile_roles(${email})`,
  );
  // Some canonical test accounts must stay single-role (e.g. manual testing of
  // the vendor self-serve signup flow can silently bolt a "vendor" row onto the
  // test manager's own email) — strip anything else so re-seeding is a real fix,
  // not just a one-time cleanup.
  if (onlyRole) {
    await must(
      supabase.from("profile_roles").delete().eq("user_id", userId).neq("role", role),
      `profile_roles(strip stray roles for ${email})`,
    );
  }
  return userId;
}

try {
  const adminId = await ensureUser(adminEmail, adminPassword, "admin");

  // Stable manager business id: reuse the profile's existing id (or derive one from
  // the auth user id) so re-runs never mint a new MGR- id per testRunId — that used
  // to accumulate manager_purchases rows and orphan previously seeded records.
  const { data: managerList, error: managerListErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (managerListErr) throw new Error(`listUsers: ${managerListErr.message}`);
  const existingManagerUser = managerList?.users?.find((u) => u.email?.toLowerCase() === managerEmail);
  let managerId = `MGR-TESTE2E`;
  if (existingManagerUser) {
    const { data: managerProfile } = await supabase
      .from("profiles")
      .select("manager_id")
      .eq("id", existingManagerUser.id)
      .maybeSingle();
    if (managerProfile?.manager_id?.trim()) managerId = managerProfile.manager_id.trim();
  }
  const managerUserId = await ensureUser(managerEmail, managerPassword, "manager", {
    managerId,
    onlyRole: true,
    fullName: CANONICAL_DEMO_MANAGER_NAME,
  });

  // Paid-tier purchase (FREE100 waiver = authorized paid access without Stripe; see
  // manager-tier-sync.ts). Primary test manager is Business (20 listing cap) so
  // portfolio-scale UI and plan gates match production Business accounts.
  const { data: managerPurchaseByUser } = await supabase
    .from("manager_purchases")
    .select("id, stripe_checkout_session_id")
    .eq("user_id", managerUserId)
    .maybeSingle();
  const { data: managerPurchaseByEmail } = managerPurchaseByUser
    ? { data: null }
    : await supabase
        .from("manager_purchases")
        .select("id, stripe_checkout_session_id")
        .ilike("email", managerEmail)
        .maybeSingle();
  const managerPurchase = managerPurchaseByUser ?? managerPurchaseByEmail ?? null;
  const managerPurchasePatch = {
    tier: "business",
    billing: "portal",
    promo_code: "FREE100",
    paid_at: NOW.toISOString(),
    email: managerEmail,
    manager_id: managerId,
    user_id: managerUserId,
  };
  if (managerPurchase?.id) {
    await must(
      supabase.from("manager_purchases").update(managerPurchasePatch).eq("id", managerPurchase.id),
      "manager_purchases(update business)",
    );
  } else {
    const checkoutSessionId = `seed_e2e_${managerId.replace(/[^A-Za-z0-9]+/g, "_")}`;
    await must(
      supabase.from("manager_purchases").upsert(
        {
          ...managerPurchasePatch,
          stripe_checkout_session_id: checkoutSessionId,
        },
        { onConflict: "manager_id" },
      ),
      "manager_purchases",
    );
  }
  // Give the manager a REAL Stripe test customer + default test card (not a
  // hand-typed cus_test_* placeholder) so manager charges — e.g. applicant
  // screening (src/lib/screening/charge-manager.ts) — succeed in test mode.
  await ensureManagerStripeCustomer(stripe, supabase, { email: managerEmail, userId: managerUserId });
  await ensureManagerLandlordProfile(managerUserId, CANONICAL_DEMO_MANAGER_NAME);

  // ── Second test manager (public browse catalog) ────────────────────────────
  const manager2Email = (process.env.E2E_MANAGER2_EMAIL?.trim() || "manager2@test.proplane.local").toLowerCase();
  const manager2Password = process.env.E2E_MANAGER2_PASSWORD?.trim() || "TestManager123!";
  const existingManager2User = managerList?.users?.find((u) => u.email?.toLowerCase() === manager2Email);
  let manager2Id = "MGR-TESTE2E2";
  if (existingManager2User) {
    const { data: manager2Profile } = await supabase
      .from("profiles")
      .select("manager_id")
      .eq("id", existingManager2User.id)
      .maybeSingle();
    if (manager2Profile?.manager_id?.trim()) manager2Id = manager2Profile.manager_id.trim();
  }
  const manager2UserId = await ensureUser(manager2Email, manager2Password, "manager", {
    managerId: manager2Id,
    onlyRole: true,
    fullName: "Test Manager 2",
  });

  const { data: purchases2 } = await supabase
    .from("manager_purchases")
    .select("id, tier")
    .eq("user_id", manager2UserId);
  const manager2HasPaidTier = (purchases2 ?? []).some((p) => {
    const t = String(p.tier ?? "").toLowerCase();
    return t === "pro" || t === "business";
  });
  if (!manager2HasPaidTier) {
    await must(
      supabase.from("manager_purchases").upsert(
        {
          stripe_checkout_session_id: "seed_e2e_m2",
          email: manager2Email,
          manager_id: manager2Id,
          tier: "pro",
          billing: "portal",
          user_id: manager2UserId,
          promo_code: "FREE100",
          paid_at: NOW.toISOString(),
        },
        { onConflict: "manager_id" },
      ),
      "manager_purchases(manager2)",
    );
  }
  await ensureManagerStripeCustomer(stripe, supabase, { email: manager2Email, userId: manager2UserId });
  await ensureManagerLandlordProfile(manager2UserId, "Test Manager 2");

  // ── Canonical demo / E2E resident + vendor (mirror /demo idle portfolio) ───
  const residentUserId = await ensureUser(residentEmail, residentPassword, "resident", {
    onlyRole: true,
    metadata: { axis_id: residentAxisId },
    fullName: PRIMARY_RESIDENT_NAME,
  });

  const vendorUserId = await ensureUser(vendorEmail, vendorPassword, "vendor", {
    onlyRole: true,
    fullName: CANONICAL_DEMO_VENDOR_NAME,
  });

  // ── All-portals sandbox account (testeverything@) ─────────────────────────
  // One login for manual testing across every portal. Primary profiles.role
  // stays "manager" (dual-role auth prefers manager); the extra profile_roles
  // rows unlock the admin/resident/vendor portals in the sign-in role picker.
  // NOT onlyRole — stripping the extra roles would defeat the account.
  const existingEverythingUser = managerList?.users?.find(
    (u) => u.email?.toLowerCase() === everythingEmail,
  );
  let everythingManagerId = "MGR-TESTEVERY";
  if (existingEverythingUser) {
    const { data: everythingProfile } = await supabase
      .from("profiles")
      .select("manager_id")
      .eq("id", existingEverythingUser.id)
      .maybeSingle();
    if (everythingProfile?.manager_id?.trim()) everythingManagerId = everythingProfile.manager_id.trim();
  }
  const everythingUserId = await ensureUser(everythingEmail, everythingPassword, "manager", {
    managerId: everythingManagerId,
    fullName: EVERYTHING_NAME,
  });
  for (const extraRole of ["admin", "resident", "vendor"]) {
    await must(
      supabase
        .from("profile_roles")
        .upsert({ user_id: everythingUserId, role: extraRole }, { onConflict: "user_id,role" }),
      `profile_roles(${everythingEmail}:${extraRole})`,
    );
  }
  await ensureManagerLandlordProfile(everythingUserId, EVERYTHING_NAME);

  // Real phones for Claw Messenger two-way testing on localhost / test DB.
  // Manager personal cell (forward + replies): +1 510-309-8345
  // Resident personal cell: +1 510-579-4001
  // Shared Claw agent line on sms_from_number while Twilio A2P is pending.
  const TEST_MANAGER_PHONE = "+15103098345";
  const TEST_RESIDENT_PHONE = "+15105794001";
  const CLAW_AGENT_PHONE =
    process.env.CLAW_MESSENGER_AGENT_PHONE?.trim() ||
    process.env.NEXT_PUBLIC_CLAW_MESSENGER_AGENT_PHONE?.trim() ||
    "+12053690702";
  const pinnedWorkNumber = process.env.TEST_MANAGER_SMS_FROM_NUMBER?.trim() || null;
  const managerSmsPatch = { sms_from_number: pinnedWorkNumber || CLAW_AGENT_PHONE };
  await must(
    supabase
      .from("profiles")
      .update({ phone: TEST_RESIDENT_PHONE, updated_at: new Date().toISOString() })
      .eq("id", residentUserId),
    "profiles(phone resident)",
  );
  await must(
    supabase
      .from("profiles")
      .update({
        phone: TEST_MANAGER_PHONE,
        ...managerSmsPatch,
        updated_at: new Date().toISOString(),
      })
      .eq("id", everythingUserId),
    "profiles(phone+sms testeverything)",
  );
  await must(
    supabase
      .from("profiles")
      .update({
        phone: TEST_MANAGER_PHONE,
        ...managerSmsPatch,
        updated_at: new Date().toISOString(),
      })
      .eq("id", managerUserId),
    "profiles(phone+sms manager)",
  );
  // Pro tier so tier-gated manager tabs aren't paywalled for this account either.
  const { data: everythingPurchases } = await supabase
    .from("manager_purchases")
    .select("id, tier")
    .eq("user_id", everythingUserId);
  const everythingHasPaidTier = (everythingPurchases ?? []).some((p) => {
    const t = String(p.tier ?? "").toLowerCase();
    return t === "pro" || t === "business";
  });
  if (!everythingHasPaidTier) {
    await must(
      supabase.from("manager_purchases").upsert(
        {
          stripe_checkout_session_id: "seed_e2e_everything",
          email: everythingEmail,
          manager_id: everythingManagerId,
          tier: "pro",
          billing: "portal",
          user_id: everythingUserId,
          promo_code: "FREE100",
          paid_at: NOW.toISOString(),
        },
        { onConflict: "manager_id" },
      ),
      "manager_purchases(everything)",
    );
  }

  async function cleanLegacyDemoManagerPortfolio(uid) {
    const tables = [
      "manager_property_records",
      "manager_application_records",
      "portal_household_charge_records",
      "portal_recurring_rent_profile_records",
      "portal_lease_pipeline_records",
      "portal_work_order_records",
      "manager_vendor_records",
      "manager_promotion_records",
      "portal_service_request_records",
      "portal_schedule_records",
    ];
    for (const table of tables) {
      await must(supabase.from(table).delete().eq("manager_user_id", uid), `clean ${table}`);
    }
    await must(
      supabase.from("portal_inbox_thread_records").delete().eq("owner_user_id", uid),
      "clean manager inbox",
    );
    await must(supabase.from("work_order_bids").delete().eq("manager_user_id", uid), "clean work_order_bids");
    await must(supabase.from("vendor_payouts").delete().eq("manager_user_id", uid), "clean vendor_payouts");
  }

  await cleanLegacyDemoManagerPortfolio(managerUserId);

  const portfolioScript = path.join(__dirname, "seed-canonical-demo-portfolio.ts");
  const projectRoot = path.join(__dirname, "..", "..");
  const portfolioResult = spawnSync("npx", ["--yes", "tsx", portfolioScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SEED_MANAGER_USER_ID: managerUserId,
      SEED_RESIDENT_USER_ID: residentUserId,
      SEED_VENDOR_USER_ID: vendorUserId,
      SEED_RESIDENT_AXIS_ID: residentAxisId,
      SEED_MANAGER_EMAIL: managerEmail,
    },
    stdio: "inherit",
  });
  if (portfolioResult.status !== 0) {
    throw new Error(`seed-canonical-demo-portfolio failed (exit ${portfolioResult.status ?? "unknown"})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Coherent browse catalog on manager2@: every home shown by the public
  // browse/apply flow is fully listed and has applications + leases.
  // manager@test.proplane.local carries the /demo idle portfolio only (see above).
  // ══════════════════════════════════════════════════════════════════════════

  // ── Catalog properties (all Seattle — a supported lease jurisdiction) ─────
  const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  /** Bathrooms linked to catalog rooms so listing modals show real layout copy. */
  function buildCatalogBathrooms(p) {
    const roomIds = p.rooms.map((r) => r.id);
    if (roomIds.length === 1) {
      const roomId = roomIds[0];
      return [
        {
          id: `${p.id}-bath-1`,
          name: "Full bathroom",
          location: p.rooms[0].floor,
          amenitiesText: "Shower\nToilet\nVanity",
          photoDataUrls: [],
          videoDataUrl: null,
          shower: true,
          toilet: true,
          bathtub: false,
          assignedRoomIds: [roomId],
          accessKindByRoomId: { [roomId]: "ensuite" },
        },
      ];
    }

    const upperRoomIds = p.rooms.filter((r) => /3rd|top/i.test(r.floor)).map((r) => r.id);
    const mainRoomIds = roomIds.filter((id) => !upperRoomIds.includes(id));
    const baths = [];

    if (mainRoomIds.length > 0) {
      baths.push({
        id: `${p.id}-bath-main`,
        name: "Main hall bath",
        location: "Hallway",
        amenitiesText: "Shower\nToilet\nBathtub",
        photoDataUrls: [],
        videoDataUrl: null,
        shower: true,
        toilet: true,
        bathtub: true,
        assignedRoomIds: mainRoomIds,
        accessKindByRoomId: Object.fromEntries(mainRoomIds.map((id) => [id, "shared"])),
      });
    }

    for (const roomId of upperRoomIds) {
      baths.push({
        id: `${p.id}-bath-${roomId}`,
        name: "Upper bath",
        location: "Upper floor",
        amenitiesText: "Shower\nToilet",
        photoDataUrls: [],
        videoDataUrl: null,
        shower: true,
        toilet: true,
        bathtub: false,
        assignedRoomIds: [roomId],
        accessKindByRoomId: { [roomId]: "ensuite" },
      });
    }

    return baths;
  }

  /** Full v1 listing submission so listings render in browse AND generated leases carry real fees/rooms/rules. */
  function buildMultiRoomBundle(p) {
    if (p.rooms.length < 2) return [];
    const sorted = [...p.rooms].sort((a, b) => a.rent - b.rent);
    const first = sorted[0];
    const second = sorted[1];
    const start = first.rent + second.rent;
    return [
      {
        id: `${p.id}-bundle-multi`,
        label: "Two or more rooms",
        price: `$${start.toLocaleString("en-US")}/mo`,
        strikethrough: "",
        promo: "Combine any two or more bedrooms on one lease.",
        roomsLine: `Example: ${first.name} + ${second.name}`,
        includedRoomIds: [first.id, second.id],
      },
    ];
  }

  function buildListingSubmission(p) {
    const roomIds = p.rooms.map((r) => r.id);
    return {
      v: 1,
      buildingName: p.name,
      address: p.address,
      zip: p.zip,
      neighborhood: p.neighborhood,
      homeStructureNote: p.structureNote,
      listingPlaceCategoryId: "private_room",
      tagline: p.tagline,
      petFriendly: p.petFriendly,
      houseOverview: p.overview,
      houseRulesText:
        "Quiet hours 10pm–8am. No smoking anywhere on the premises. Overnight guests limited to 3 nights per week. Clean shared spaces after use.",
      housePhotoDataUrls: [],
      allowedLeaseTerms: ["12 months"],
      leaseTermsBody: "Available lease lengths: 12 months.",
      applicationFee: "$50",
      securityDeposit: usd(p.deposit),
      moveInFee: "$250",
      paymentAtSigningIncludes: ["security_deposit", "move_in_fee"],
      houseCostsDetail: "",
      parkingMonthly: "",
      hoaMonthly: "",
      otherMonthlyFees: "",
      sharedSpaces: [
        {
          id: "shared-kitchen",
          name: "Kitchen",
          location: "Main floor",
          detail: "Full kitchen with dishwasher, shared by all residents.",
          amenitiesText: "Refrigerator\nDishwasher\nGas range",
          photoDataUrls: [],
          videoDataUrl: null,
          roomAccessIds: roomIds,
        },
        {
          id: "shared-living",
          name: "Living room",
          location: "Main floor",
          detail: "Furnished living room with smart TV.",
          amenitiesText: "Sofa\nSmart TV",
          photoDataUrls: [],
          videoDataUrl: null,
          roomAccessIds: roomIds,
        },
      ],
      amenitiesText: "In-unit laundry\nFast Wi-Fi\nFurnished rooms",
      rooms: p.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        floor: r.floor,
        monthlyRent: r.rent,
        availability: "Now",
        moveInAvailableDate: isoDate(NOW),
        moveInInstructions: "Lockbox at front door; code shared after signing.",
        manualUnavailableRanges: [],
        detail: r.detail,
        furnishing: r.furnishing ?? "Fully furnished",
        roomAmenitiesText: r.roomAmenitiesText ?? "Closet\nHeating\nAC",
        photoDataUrls: [],
        videoDataUrl: null,
        utilitiesEstimate: "$150",
        prorateMethod: "auto",
      })),
      bathrooms: buildCatalogBathrooms(p),
      bundles: buildMultiRoomBundle(p),
      quickFacts: [],
    };
  }

  const room = (n, floor, rent, detail, extras = {}) => ({
    id: `room-${n}`,
    name: extras.name ?? `Room ${n}`,
    floor,
    rent,
    detail,
    furnishing: extras.furnishing ?? "Fully furnished",
    roomAmenitiesText: extras.roomAmenitiesText ?? "Closet\nHeating\nAC",
  });

  function buildManagerScalePortfolioProperty(index, ownerUserId) {
    const n = String(index).padStart(2, "0");
    const streets = [
      "Pine",
      "Maple",
      "Oak",
      "Elm",
      "Cedar",
      "Ash",
      "Birch",
      "Spruce",
      "Willow",
      "Cherry",
      "Hazel",
      "Juniper",
      "Laurel",
      "Rowan",
      "Aspen",
    ];
    const hoods = [
      "Capitol Hill",
      "Ballard",
      "Fremont",
      "Queen Anne",
      "West Seattle",
      "University District",
      "Green Lake",
      "Wallingford",
      "Ravenna",
      "Columbia City",
    ];
    const street = streets[(index - 1) % streets.length];
    const hood = hoods[(index - 1) % hoods.length];
    const rent = 950 + index * 35;
    return {
      id: `mgr-scale-${n}`,
      name: `${street} Flats ${index}`,
      address: `${100 + index * 7} ${street} St, Seattle, WA 981${index % 10}${index % 10}`,
      zip: `981${index % 10}${index % 10}`,
      neighborhood: hood,
      tagline: `Shared rooms on ${street} St.`,
      overview: `A furnished shared home in ${hood} with fast Wi-Fi and in-unit laundry.`,
      structureNote: "2-story house",
      petFriendly: index % 3 !== 0,
      deposit: rent,
      ownerUserId,
      rooms: [
        room(1, "2nd floor", rent, `Bright room ${index}A.`, { name: `Room ${index}A` }),
        room(2, "2nd floor", rent + 50, `Corner room ${index}B.`, { name: `Room ${index}B` }),
      ],
    };
  }

  const catalog = [
    // manager@test workflow portfolio (Cascade Lofts, Emerald Court, …)
    {
      id: "mgr-demo-cascade",
      name: "Cascade Lofts",
      address: "1200 Cascade Ave, Seattle, WA 98122",
      zip: "98122",
      neighborhood: "Capitol Hill",
      tagline: "Modern shared lofts with skyline views.",
      overview:
        "A five-bedroom shared loft building on Capitol Hill with rooftop deck, coworking nook, and quick access to light rail.",
      structureNote: "5-story loft building",
      petFriendly: true,
      deposit: 1200,
      ownerUserId: managerUserId,
      rooms: [
        room(1, "2nd floor", 1050, "Bright room with city view.", { name: "Unit 2A" }),
        room(2, "3rd floor", 1100, "Corner room with extra closet.", { name: "Unit 3C" }),
        room(3, "4th floor", 1150, "Quiet top-floor room.", { name: "Unit 4B" }),
        room(4, "4th floor", 1125, "Compact room near shared bath.", { name: "Unit 4A" }),
        room(5, "5th floor", 1200, "Penthouse room with deck access.", { name: "Unit 5D" }),
      ],
    },
    {
      id: "mgr-demo-emerald",
      name: "Emerald Court",
      address: "455 Boren Ave, Seattle, WA 98101",
      zip: "98101",
      neighborhood: "South Lake Union",
      tagline: "Whole-unit rental near the waterfront.",
      overview:
        "A furnished 3-bedroom flat in South Lake Union with open kitchen, in-unit laundry, and a short walk to Lake Union Park.",
      structureNote: "Unit in a 6-story building",
      petFriendly: false,
      deposit: 2400,
      ownerUserId: managerUserId,
      rooms: [
        {
          id: "room-1",
          name: "Unit 3",
          floor: "3rd floor",
          rent: 2400,
          detail: "Whole 3-bed unit with open kitchen and canal views.",
          furnishing: "Fully furnished",
          roomAmenitiesText: "Open kitchen\nCanal views\nIn-unit laundry",
        },
      ],
    },
    {
      id: "mgr-demo-pioneer",
      name: "The Pioneer",
      address: "88 Pioneer Square, Seattle, WA 98104",
      zip: "98104",
      neighborhood: "Pioneer Square",
      tagline: "Historic building, modern rooms.",
      overview: "Shared rooms in a renovated Pioneer Square building with exposed brick and shared roof deck.",
      structureNote: "4-story historic building",
      petFriendly: true,
      deposit: 1100,
      ownerUserId: managerUserId,
      rooms: [
        room(1, "2nd floor", 1100, "Queen bed and desk.", { name: "Room 12A" }),
        room(2, "3rd floor", 1150, "Corner room with brick accent wall.", { name: "Room 8B" }),
      ],
    },
    {
      id: "mgr-demo-lakeview",
      name: "Lakeview Studio",
      address: "2100 Westlake Ave N, Seattle, WA 98109",
      zip: "98109",
      neighborhood: "South Lake Union",
      tagline: "Water-view studio steps from the park.",
      overview: "Top-floor studio with kitchenette and lake views, ideal for a single professional.",
      structureNote: "Top-floor studio",
      petFriendly: false,
      deposit: 1800,
      ownerUserId: managerUserId,
      rooms: [
        {
          id: "room-1",
          name: "Studio",
          floor: "6th floor",
          rent: 1800,
          detail: "Open studio with kitchenette and lake views.",
          furnishing: "Fully furnished",
          roomAmenitiesText: "Kitchenette\nLake views\nCloset",
        },
      ],
    },
    {
      id: "mgr-demo-ballard",
      name: "Ballard House",
      address: "5400 Ballard Ave NW, Seattle, WA 98107",
      zip: "98107",
      neighborhood: "Ballard",
      tagline: "Cozy shared house near the market.",
      overview: "A 3-room shared house in Ballard with backyard, shared kitchen, and walkable restaurants.",
      structureNote: "2-story house",
      petFriendly: true,
      deposit: 1050,
      ownerUserId: managerUserId,
      rooms: [
        room(1, "1st floor", 1050, "Garden-level room.", { name: "Room 1" }),
        room(2, "2nd floor", 1100, "Front-facing room.", { name: "Room 2" }),
        room(3, "2nd floor", 1125, "Rear quiet room.", { name: "Room 3" }),
      ],
    },
    {
      id: "mgr-test-alder",
      name: "Alder Row — 3 rooms",
      address: "230 Alder Row, Seattle, WA 98144",
      zip: "98144",
      neighborhood: "Beacon Hill",
      tagline: "Sunny shared house steps from light rail.",
      overview:
        "A renovated 3-room shared craftsman on Beacon Hill with a shared kitchen, fast Wi-Fi, and in-unit laundry. Five minutes to the light rail station.",
      structureNote: "2-story craftsman",
      petFriendly: true,
      deposit: 1150,
      ownerUserId: manager2UserId,
      rooms: [
        room(1, "2nd floor", 1150, "Queen bed and desk; south-facing window.", {
          roomAmenitiesText: "South-facing window\nCloset\nHeating",
        }),
        room(2, "2nd floor", 1100, "Full bed and closet; faces the garden.", {
          roomAmenitiesText: "Garden view\nCloset",
        }),
        room(3, "1st floor", 1050, "Cozy room next to the living room.", {
          roomAmenitiesText: "Near living room\nCloset",
        }),
      ],
    },
    {
      id: "mgr-test-birch",
      name: "Birch Court — 4 rooms",
      address: "812 Birch St, Seattle, WA 98107",
      zip: "98107",
      neighborhood: "Ballard",
      tagline: "Bright rooms near the water and transit.",
      overview:
        "A bright 4-room shared house in Ballard with a large kitchen, backyard deck, and quick access to the Burke-Gilman trail and rapid-ride buses.",
      structureNote: "2-story house with deck",
      petFriendly: true,
      deposit: 1250,
      ownerUserId: manager2UserId,
      rooms: [
        room(1, "2nd floor", 1250, "Corner room with two windows.", {
          roomAmenitiesText: "Two windows\nCorner layout\nCloset",
        }),
        room(2, "2nd floor", 1200, "Queen bed; faces the courtyard.", {
          roomAmenitiesText: "Courtyard view\nCloset",
        }),
        room(3, "1st floor", 1150, "Quiet room off the back hall.", {
          roomAmenitiesText: "Quiet location\nCloset",
        }),
        room(4, "1st floor", 1100, "Compact room with garden view.", {
          roomAmenitiesText: "Garden view\nCloset",
        }),
      ],
    },
    {
      id: "mgr-test-magnolia",
      name: "Magnolia House — 5 rooms",
      address: "1420 Magnolia Ave, Seattle, WA 98122",
      zip: "98122",
      neighborhood: "Capitol Hill",
      tagline: "Furnished shared house, flexible terms.",
      overview:
        "A furnished 5-room shared house on Capitol Hill with two full bathrooms, a shared rooftop deck, and nightlife, groceries, and the streetcar within blocks.",
      structureNote: "3-story house with rooftop deck",
      petFriendly: true,
      deposit: 1300,
      ownerUserId: manager2UserId,
      rooms: [
        room(1, "3rd floor", 1300, "Top-floor room with skyline view.", {
          roomAmenitiesText: "Skylight\nSkyline view\nCloset",
        }),
        room(2, "3rd floor", 1250, "Bright room with built-in shelving.", {
          roomAmenitiesText: "Built-in shelving\nCloset",
        }),
        room(3, "2nd floor", 1200, "Queen bed and reading nook.", {
          roomAmenitiesText: "Reading nook\nCloset",
        }),
        room(4, "2nd floor", 1150, "Faces the quiet side street.", {
          roomAmenitiesText: "Quiet street view\nCloset",
        }),
        room(5, "1st floor", 1050, "Garden-level room with private entrance.", {
          roomAmenitiesText: "Private entrance\nGarden access",
        }),
      ],
    },
    {
      id: "mgr-test-fir",
      name: "Fir Lofts",
      address: "77 Fir Loft Rd, Seattle, WA 98109",
      zip: "98109",
      neighborhood: "South Lake Union",
      tagline: "Industrial loft with skyline views.",
      overview:
        "A sunlit top-floor loft in South Lake Union with exposed brick, 16-foot ceilings, skyline views, and a five-minute walk to the streetcar and Lake Union Park.",
      structureNote: "Top-floor loft in a converted warehouse",
      petFriendly: false,
      deposit: 2100,
      ownerUserId: manager2UserId,
      rooms: [
        {
          id: "room-1",
          name: "Loft 3",
          floor: "3rd floor",
          rent: 2100,
          detail: "Open-plan loft with exposed brick and skyline views.",
          furnishing: "Fully furnished",
          roomAmenitiesText: "Open living area\nSkylight views\nBuilt-in storage",
        },
      ],
    },
    {
      id: "mgr-test-cedar",
      name: "Cedar Flat 2B",
      address: "455 Cedar Way, Seattle, WA 98103",
      zip: "98103",
      neighborhood: "Fremont",
      tagline: "Modern 2-bed near the canal.",
      overview:
        "A modern 2-bedroom flat in Fremont rented as a whole unit, with an open kitchen, in-unit laundry, and the canal path at the end of the block.",
      structureNote: "Unit 2B in a 6-unit building",
      petFriendly: false,
      deposit: 2400,
      ownerUserId: manager2UserId,
      rooms: [
        {
          id: "room-1",
          name: "Unit 2B",
          floor: "2nd floor",
          rent: 2400,
          detail: "Whole 2-bed unit with open kitchen and canal views.",
          furnishing: "Fully furnished",
          roomAmenitiesText: "Open kitchen\nCanal views\nIn-unit laundry",
        },
      ],
    },
    {
      id: "mgr-test-spruce",
      name: "Spruce Studio",
      address: "9 Spruce Ln, Seattle, WA 98119",
      zip: "98119",
      neighborhood: "Queen Anne",
      tagline: "Quiet top-floor studio on Queen Anne.",
      overview:
        "A quiet top-floor studio on Queen Anne with a kitchenette, big windows, and a short walk to Kerry Park and downtown buses.",
      structureNote: "Top-floor studio",
      petFriendly: false,
      deposit: 1750,
      ownerUserId: manager2UserId,
      rooms: [
        {
          id: "room-1",
          name: "Studio",
          floor: "3rd floor",
          rent: 1750,
          detail: "Open studio with kitchenette and big windows.",
          furnishing: "Fully furnished",
          roomAmenitiesText: "Kitchenette\nBig windows\nCloset",
        },
      ],
    },
  ];

  // Business-tier test manager (`manager@test`) carries 20 live listings: the five
  // workflow demo homes plus fifteen scale portfolio rows (manager2 keeps its own
  // browse catalog so E2E browse flows stay isolated).
  for (let i = 1; i <= 15; i += 1) {
    catalog.push(buildManagerScalePortfolioProperty(i, managerUserId));
  }

  const propertyRows = catalog.map((p) => {
    const submission = buildListingSubmission(p);
    const rents = p.rooms.map((r) => r.rent);
    const minRent = Math.min(...rents);
    const maxRent = Math.max(...rents);
    const rentLabel =
      minRent === maxRent
        ? `$${minRent.toLocaleString("en-US")} / mo`
        : `$${minRent.toLocaleString("en-US")}–$${maxRent.toLocaleString("en-US")} / mo`;
    const unitLabel = p.rooms.length === 1 ? p.rooms[0].name : `${p.rooms.length} rooms`;
    return {
      id: p.id,
      manager_user_id: p.ownerUserId,
      status: "live",
      property_data: {
        id: p.id,
        title: p.name,
        tagline: p.tagline,
        address: p.address,
        zip: p.zip,
        neighborhood: p.neighborhood,
        beds: Math.max(p.rooms.length, 1),
        baths: p.rooms.length >= 4 ? 2 : 1,
        rentLabel,
        available: "Now",
        petFriendly: p.petFriendly,
        buildingId: `${p.id}-bld`,
        buildingName: p.name,
        unitLabel,
        mapLat: 47.61405,
        mapLng: -122.31542,
        managerUserId: p.ownerUserId,
        adminPublishLive: true,
        listingSubmission: submission,
      },
      row_data: {
        id: p.id,
        status: "live",
        name: p.name,
        buildingName: p.name,
        address: p.address,
        testRunId,
      },
      updated_at: NOW.toISOString(),
    };
  });
  await must(supabase.from("manager_property_records").upsert(propertyRows, { onConflict: "id" }), "manager_property_records(catalog)");

  const promotionScript = path.join(__dirname, "seed-manager-promotion-defaults.ts");
  const promotionResult = spawnSync("npx", ["--yes", "tsx", promotionScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SEED_MANAGER_USER_ID: managerUserId,
      SEED_MANAGER_EMAIL: managerEmail,
    },
    stdio: "inherit",
  });
  if (promotionResult.status !== 0) {
    throw new Error(`seed-manager-promotion-defaults failed (exit ${promotionResult.status ?? "unknown"})`);
  }

  // Tour calendar: open availability slots, confirmed tours, and pending requests
  // for manager2's browse catalog and manager@test's demo portfolio.
  const manager2TourProperties = catalog
    .filter((p) => p.ownerUserId === manager2UserId)
    .map((p) => ({ id: p.id, name: p.name }));
  const managerTourProperties = catalog
    .filter((p) => p.ownerUserId === managerUserId)
    .map((p) => ({ id: p.id, name: p.name }));

  await seedScheduleToursForManager({
    managerUserId: manager2UserId,
    hostLabel: "Test Manager 2",
    properties: manager2TourProperties,
  });
  await seedScheduleToursForManager({
    managerUserId,
    hostLabel: CANONICAL_DEMO_MANAGER_NAME,
    properties: managerTourProperties,
  });

  // Retire legacy `record_type: event` rows — the portal reads planned/inquiry singletons.
  for (const legacyId of ["test-tour-fir", "test-tour-cedar"]) {
    await supabase.from("portal_schedule_records").delete().eq("id", legacyId);
  }

  const propById = new Map(catalog.map((p) => [p.id, p]));

  // ── Applicants: every catalog property gets ≥1 approved application (which
  //    drives a lease) plus pending/rejected spread for realistic buckets. ────
  const AUTO_RESIDENT_PASSWORD = "123Password$"; // mirrors provision-approved-resident.ts
  // `screen: "consider"` = completed Checkr report that did NOT auto-pass
  // (result "consider" → badge "flagged"), so Applications → Screening shows a
  // mix of passed vs needs-manual-review and the manual screening flow is
  // demonstrable. Everyone else gets a clear (passed) report.
  const people = [
    // Primary E2E resident (resident@test) — full approved application, signed lease, charges.
    {
      axisId: residentAxisId,
      first: "Test",
      last: "Resident",
      propId: "mgr-demo-lakeview",
      roomId: "room-1",
      bucket: "approved",
      leaseStage: "signed",
      income: 102000,
      primaryE2e: true,
    },
    // manager@test workflow residents — full applications + leases across pipeline stages
    { axisId: "AXIS-DEMMARCUSC", first: "Marcus", last: "Chen", propId: "mgr-demo-emerald", roomId: "room-1", bucket: "approved", leaseStage: "manager", income: 115000 },
    { axisId: "AXIS-DEMPRIYAS", first: "Priya", last: "Sharma", propId: "mgr-demo-cascade", roomId: "room-3", bucket: "approved", leaseStage: "manager", income: 108000 },
    { axisId: "AXIS-DEMOJORDL", first: "Jordan", last: "Lee", propId: "mgr-demo-pioneer", roomId: "room-1", bucket: "approved", leaseStage: "signed", income: 96000 },
    { axisId: "AXIS-DEMOAVAN", first: "Ava", last: "Nguyen", propId: "mgr-demo-lakeview", roomId: "room-1", bucket: "approved", leaseStage: "manager_sign", income: 88000 },
    { axisId: "AXIS-DEMODIEGM", first: "Diego", last: "Morales", propId: "mgr-demo-cascade", roomId: "room-1", bucket: "approved", leaseStage: "resident_sign", income: 91000 },
    { axisId: "AXIS-DEMOSOFID", first: "Sofia", last: "Diaz", propId: "mgr-demo-ballard", roomId: "room-1", bucket: "approved", leaseStage: "signed", income: 104000 },
    { axisId: "AXIS-DEMOMYACH", first: "Maya", last: "Chen", propId: "mgr-demo-cascade", roomId: "room-5", bucket: "approved", leaseStage: "signed", income: 99000 },
    { axisId: "AXIS-DEMOLIAMF", first: "Liam", last: "Foster", propId: "mgr-demo-pioneer", roomId: "room-2", bucket: "approved", leaseStage: "signed", income: 98000 },
    { axisId: "AXIS-DEMOETHW", first: "Ethan", last: "Wright", propId: "mgr-demo-cascade", roomId: "room-2", bucket: "pending", income: 71000, screen: "consider" },
    { axisId: "AXIS-DEMOOLIB", first: "Olivia", last: "Brooks", propId: "mgr-demo-cascade", roomId: "room-4", bucket: "pending", income: 68000 },
    { axisId: "AXIS-DEMOLUCK", first: "Lucas", last: "Kim", propId: "mgr-demo-ballard", roomId: "room-3", bucket: "rejected", income: 40000, rejectReason: "Income below 2.5x rent.", screen: "consider" },
    { axisId: "AXIS-DEMOMASC", first: "Mason", last: "Clark", propId: "mgr-demo-ballard", roomId: "room-2", bucket: "pending", income: 88000, screen: "consider" },
    // manager2@test browse catalog residents
    { axisId: "AXIS-TESTMAYACH", first: "Maya", last: "Chen", propId: "mgr-test-alder", roomId: "room-1", bucket: "approved", leaseStage: "signed", income: 96000 },
    { axisId: "AXIS-TESTETHANW", first: "Ethan", last: "Wright", propId: "mgr-test-alder", roomId: "room-2", bucket: "pending", income: 71000, screen: "consider" },
    { axisId: "AXIS-TESTDIEGOM", first: "Diego", last: "Morales", propId: "mgr-test-birch", roomId: "room-1", bucket: "approved", leaseStage: "resident_sign", income: 91000 },
    { axisId: "AXIS-TESTOLIVIB", first: "Olivia", last: "Brooks", propId: "mgr-test-birch", roomId: "room-2", bucket: "pending", income: 68000 },
    { axisId: "AXIS-TESTSOFIAD", first: "Sofia", last: "Diaz", propId: "mgr-test-magnolia", roomId: "room-1", bucket: "approved", leaseStage: "signed", income: 104000 },
    { axisId: "AXIS-TESTNOAHPA", first: "Noah", last: "Park", propId: "mgr-test-magnolia", roomId: "room-2", bucket: "approved", leaseStage: "manager_sign", income: 79000 },
    { axisId: "AXIS-TESTLUCASK", first: "Lucas", last: "Kim", propId: "mgr-test-magnolia", roomId: "room-3", bucket: "rejected", income: 40000, rejectReason: "Income below 2.5x rent.", screen: "consider" },
    { axisId: "AXIS-TESTLIAMFO", first: "Liam", last: "Foster", propId: "mgr-test-fir", roomId: "room-1", bucket: "approved", leaseStage: "signed", income: 98000 },
    { axisId: "AXIS-TESTISABEN", first: "Isabella", last: "Nguyen", propId: "mgr-test-cedar", roomId: "room-1", bucket: "approved", leaseStage: "manager", income: 120000 },
    { axisId: "AXIS-TESTMASONC", first: "Mason", last: "Clark", propId: "mgr-test-cedar", roomId: "room-1", bucket: "pending", income: 88000, screen: "consider" },
    { axisId: "AXIS-TESTAVAROS", first: "Ava", last: "Rossi", propId: "mgr-test-spruce", roomId: "room-1", bucket: "approved", leaseStage: "manager", income: 82000 },
  ].map((p, i) => {
    const prop = propById.get(p.propId);
    const roomDef = prop.rooms.find((r) => r.id === p.roomId);
    const suffix = prop.ownerUserId === managerUserId ? "workflow" : "e2e";
    return {
      ...p,
      index: i,
      name: `${p.first} ${p.last}`,
      email: p.primaryE2e
        ? residentEmail
        : `${p.first}.${p.last}.${suffix}@test.proplane.local`.toLowerCase(),
      prop,
      room: roomDef,
      rent: roomDef.rent,
      roomChoice: `${p.propId}::${p.roomId}`,
    };
  });

  /** Full RentalWizardFormState mirroring the primary resident's application above. */
  function buildCatalogApplication(p) {
    const appLeaseStart = isoDate(daysFromNow(10));
    const appLeaseEnd = isoDate(daysFromNow(375));
    const ssnGroup = String(12 + (p.index % 88)).padStart(2, "0");
    const ssnSerial = String(1000 + p.index).padStart(4, "0");
    return {
      fullLegalName: p.name,
      email: p.email,
      phone: p.index % 2 === 0 ? "(510) 309-8345" : "(510) 579-4001",
      dateOfBirth: `199${p.index % 10}-0${(p.index % 9) + 1}-14`,
      ssn: `000-${ssnGroup}-${ssnSerial}`,
      driversLicense: `WA-DL-${4821000 + p.index}`,
      employer: "Northwest Tech Co.",
      jobTitle: "Analyst",
      employerAddress: "500 Union St, Seattle, WA",
      employmentStart: "2022-03-01",
      supervisorName: "Dana Wells",
      supervisorPhone: "(206) 555-0133",
      monthlyIncome: String(Math.round(p.income / 12)),
      annualIncome: String(p.income),
      notEmployed: false,
      otherIncome: "",
      occupancyCount: "1",
      pets: "None",
      currentStreet: "88 Maple Court",
      currentCity: "Seattle",
      currentState: "WA",
      currentZip: "98122",
      currentMoveIn: "2023-06-01",
      currentMoveOut: "",
      currentLandlordName: "Cedar Property Mgmt",
      currentLandlordPhone: "(206) 555-0190",
      currentReasonLeaving: "Relocating closer to work",
      noPreviousAddress: false,
      prevStreet: "4102 Oak Glen Dr",
      prevCity: "Seattle",
      prevState: "WA",
      prevZip: "98115",
      prevMoveIn: "2021-01-15",
      prevMoveOut: "2023-05-30",
      prevLandlordName: "Sunset Property Mgmt",
      prevLandlordPhone: "(206) 555-0177",
      prevReasonLeaving: "Lease ended",
      ref1Name: "Priya Nair",
      ref1Phone: "(206) 555-0166",
      ref1Relationship: "Former colleague",
      ref2Name: "Marcus Lee",
      ref2Phone: "(206) 555-0188",
      ref2Relationship: "Friend",
      criminalHistory: "no",
      criminalDetails: "",
      evictionHistory: "no",
      evictionDetails: "",
      bankruptcyHistory: "no",
      bankruptcyDetails: "",
      hasCosigner: "no",
      applyingAsGroup: "no",
      groupId: "",
      groupRole: null,
      groupSize: "",
      propertyId: p.propId,
      rentalType: "standard",
      leaseTerm: "12 months",
      leaseStart: appLeaseStart,
      leaseEnd: appLeaseEnd,
      roomChoice1: p.roomChoice,
      roomChoice2: "",
      roomChoice3: "",
      shortTermCheckInTime: "",
      shortTermCheckOutTime: "",
      managerRentOverride: String(p.rent),
      managerUtilitiesOverride: "150",
      managerSecurityDepositOverride: String(p.prop.deposit),
      managerMoveInFeeOverride: "250",
      managerOtherCostLabel: "",
      managerOtherCostAmount: "",
      __signedRentLabel: `${usd(p.rent)} / month`,
      consentTruth: true,
      consentCredit: true,
      dateSigned: isoDate(daysFromNow(-2)),
      digitalSignature: p.name,
      applicationFeePayChannel: "stripe",
      applicationFeeAcknowledged: true,
      applicationFeeZelleSentConfirmed: false,
    };
  }

  // Completed (simulated) Checkr report stored the same way
  // runBackgroundCheck persists it (src/lib/checkr/background-check.ts):
  // `backgroundCheck` is the Checkr object, `backgroundCheckStatus` the badge
  // backgroundCheckStatusFromCheckr derives — "passed" for clear, "flagged"
  // (needs manual review) for consider. Stable ids keep re-runs idempotent.
  function buildSeedBackgroundCheck(p) {
    const consider = p.screen === "consider";
    return {
      provider: "checkr",
      candidateId: `seed-cand-${p.axisId.toLowerCase()}`,
      reportId: `seed-report-${p.axisId.toLowerCase()}`,
      packageSlug: "test_pro_criminal",
      status: "complete",
      result: consider ? "consider" : "clear",
      assessment: consider ? "review" : "eligible",
      orderedAt: daysFromNow(-2).toISOString(),
      completedAt: daysFromNow(-1).toISOString(),
      simulated: true,
    };
  }

  async function provisionSeedResidentAccount(p) {
    const claimedAt = NOW.toISOString();
    const approved = p.bucket === "approved";
    const userId = await ensureUser(p.email, AUTO_RESIDENT_PASSWORD, "resident", {
      metadata: {
        axis_id: p.axisId,
        auto_provisioned_resident: false,
        resident_password_claimed_at: claimedAt,
      },
      fullName: p.name,
    });
    await must(
      supabase.from("profiles").upsert(
        {
          id: userId,
          email: p.email,
          role: "resident",
          manager_id: p.axisId,
          full_name: p.name,
          application_approved: approved,
        },
        { onConflict: "id" },
      ),
      `profiles(${p.email})`,
    );
    p.residentUserId = userId;
    p.setupTokenConsumedAt = claimedAt;
    return userId;
  }

  // Resident accounts for every seeded applicant (approved + pending + rejected).
  for (const p of people) {
    if (p.primaryE2e) {
      p.residentUserId = residentUserId;
      await must(
        supabase.from("profiles").upsert(
          {
            id: residentUserId,
            email: residentEmail,
            role: "resident",
            manager_id: residentAxisId,
            full_name: PRIMARY_RESIDENT_NAME,
            application_approved: true,
          },
          { onConflict: "id" },
        ),
        `profiles(${residentEmail})`,
      );
      continue;
    }
    await provisionSeedResidentAccount(p);
  }

  function buildApplicationRow(p) {
    const approved = p.bucket === "approved";
    const stage = approved ? "Approved - placed" : p.bucket === "rejected" ? "Rejected" : "Submitted";
    const detail = approved
      ? `Approved for ${p.room.name}`
      : p.bucket === "rejected"
        ? p.rejectReason
        : `Submitted ${isoDate(daysFromNow(-1))}`;
    const backgroundCheck = buildSeedBackgroundCheck(p);
    return {
      id: p.axisId,
      manager_user_id: p.prop.ownerUserId,
      resident_email: p.email,
      property_id: p.propId,
      assigned_property_id: approved ? p.propId : null,
      row_data: {
        id: p.axisId,
        axisId: p.axisId,
        bucket: p.bucket,
        stage,
        detail,
        email: p.email,
        name: p.name,
        property: p.prop.name,
        application: buildCatalogApplication(p),
        backgroundCheck,
        backgroundCheckStatus: backgroundCheck.result === "clear" ? "passed" : "flagged",
        managerUserId: p.prop.ownerUserId,
        propertyId: p.propId,
        residentUserId: p.residentUserId ?? null,
        setupTokenConsumedAt: p.setupTokenConsumedAt ?? null,
        ...(approved
          ? {
              assignedPropertyId: p.propId,
              assignedRoomChoice: p.roomChoice,
              signedMonthlyRent: p.rent,
            }
          : {}),
        testRunId,
      },
      updated_at: NOW.toISOString(),
    };
  }

  const applicationRows = people.map(buildApplicationRow);
  await must(supabase.from("manager_application_records").upsert(applicationRows, { onConflict: "id" }), "manager_application_records(catalog)");

  const approvedPeople = people.filter((p) => p.bucket === "approved");

  // ── Leases: one per approved application, spread across pipeline stages.
  //    Ids use the app's own convention (lease_app_<axisId>, see
  //    lease-pipeline-storage.ts syncApprovedApplications) so the portal reuses
  //    these rows instead of auto-creating duplicates. ───────────────────────
  const leaseHtmlStub = (p) =>
    `<section class="lease-doc"><h1>Residential Lease Agreement</h1>` +
    `<p><strong>Tenant:</strong> ${p.name}</p><p><strong>Premises:</strong> ${p.prop.name} · ${p.room.name}</p>` +
    `<p><strong>Monthly Rent:</strong> ${usd(p.rent)}</p><p><strong>Term:</strong> 12 months</p>` +
    `<p>This agreement is generated from the approved rental application and governed by Washington State (Seattle) law.</p></section>`;

  function buildCatalogLeaseHtml(p) {
    try {
      return buildSeedLeaseHtml({
        application: buildCatalogApplication(p),
        propertyData: {
          id: p.propId,
          title: p.prop.name,
          address: p.prop.address,
          managerUserId: p.prop.ownerUserId,
          listingSubmission: buildListingSubmission(p.prop),
        },
        monthlyRent: p.rent,
      });
    } catch (err) {
      console.error(`buildSeedLeaseHtml failed for ${p.axisId}: ${err.message}`);
      return leaseHtmlStub(p);
    }
  }

  function buildCatalogLeaseRow(p) {
    const genIso = daysFromNow(-4).toISOString();
    const sentIso = daysFromNow(-3).toISOString();
    const resSignIso = daysFromNow(-2).toISOString();
    const mgrSignIso = daysFromNow(-1).toISOString();
    const row = {
      id: `lease_app_${p.axisId}`,
      residentName: p.name,
      residentEmail: p.email,
      unit: `${p.prop.name} · ${p.room.name}`,
      updated: "just now",
      pdfVersion: 2,
      versionNumber: 2,
      notes: "Created from approved application.",
      updatedAtIso: NOW.toISOString(),
      axisId: p.axisId,
      propertyId: p.propId,
      managerUserId: p.prop.ownerUserId,
      residentUserId: p.residentUserId ?? null,
      roomChoice: p.roomChoice,
      signedRentLabel: `${usd(p.rent)} / month`,
      application: buildCatalogApplication(p),
      generatedHtml: buildCatalogLeaseHtml(p),
      generatedAtIso: genIso,
      managerUploadedPdf: null,
      thread: [],
      managerSignature: null,
      residentSignature: null,
      signatureName: null,
      signedAtIso: null,
      residentSignedAt: null,
      managerSignedAt: null,
      adminReviewRequestedAt: null,
      sentToResidentAt: null,
      fullySignedAt: null,
      voidedAt: null,
      bucket: "manager",
      status: "Manager Review",
      stageLabel: "Manager Review",
      currentActorRole: "manager",
      testRunId,
    };
    if (p.leaseStage === "manager") return row;
    if (p.leaseStage === "admin") {
      return row;
    }
    if (p.leaseStage === "resident_sign") {
      return { ...row, bucket: "resident", status: "Resident Signature Pending", stageLabel: "Resident Signature Pending", currentActorRole: "resident", sentToResidentAt: sentIso };
    }
    const resSig = { name: p.name, signedAtIso: resSignIso, role: "resident" };
    if (p.leaseStage === "manager_sign") {
      return {
        ...row,
        bucket: "signed",
        status: "Manager Signature Pending",
        stageLabel: "Manager Signature Pending",
        currentActorRole: "manager",
        sentToResidentAt: sentIso,
        residentSignature: resSig,
        signatureName: p.name,
        signedAtIso: resSignIso,
        residentSignedAt: resSignIso,
      };
    }
    // signed (Fully Signed)
    return {
      ...row,
      bucket: "signed",
      status: "Fully Signed",
      stageLabel: "Signed",
      currentActorRole: "system",
      sentToResidentAt: sentIso,
      residentSignature: resSig,
      managerSignature: { name: "Test Manager", signedAtIso: mgrSignIso, role: "manager" },
      signatureName: p.name,
      signedAtIso: resSignIso,
      residentSignedAt: resSignIso,
      managerSignedAt: mgrSignIso,
      fullySignedAt: mgrSignIso,
    };
  }

  const leaseRows = approvedPeople.map((p) => {
    const row = buildCatalogLeaseRow(p);
    return {
      id: row.id,
      manager_user_id: p.prop.ownerUserId,
      resident_user_id: p.residentUserId ?? null,
      resident_email: p.email,
      property_id: p.propId,
      status: row.bucket,
      row_data: { ...row, residentUserId: p.residentUserId ?? null },
      updated_at: NOW.toISOString(),
    };
  });
  await must(
    supabase.from("portal_lease_pipeline_records").upsert(leaseRows, { onConflict: "id" }),
    "portal_lease_pipeline_records(catalog)",
  );

  const leaseEndIso = isoDate(daysFromNow(375));
  const moveInDueLabel = isoDate(daysFromNow(10));
  const chargeRows = [];
  const rentProfileRows = [];
  for (const p of approvedPeople) {
    const charges = buildSeedChargesForPerson(p, { now: NOW, moveInDueLabel });
    chargeRows.push(...charges.map(householdChargeDbRow));
    const profile = buildSeedRentProfileForPerson(p, { now: NOW, leaseEndIso });
    if (profile) rentProfileRows.push(rentProfileDbRow(profile));
  }
  if (chargeRows.length) {
    await must(
      supabase.from("portal_household_charge_records").upsert(chargeRows, { onConflict: "id" }),
      "portal_household_charge_records(catalog)",
    );
  }
  if (rentProfileRows.length) {
    await must(
      supabase.from("portal_recurring_rent_profile_records").upsert(rentProfileRows, { onConflict: "id" }),
      "portal_recurring_rent_profile_records(catalog)",
    );
  }

  // Canonical auth inboxes must never be auto-provisioned as residents — a stray
  // application row keyed by a manager business id (e.g. PROPLANE-…) can list
  // manager@test.proplane.local as resident_email and would otherwise reset the E2E
  // manager password to AUTO_RESIDENT_PASSWORD during repair.
  const canonicalAuthEmails = new Set([
    adminEmail,
    managerEmail,
    manager2Email,
    residentEmail,
    vendorEmail,
    everythingEmail,
  ]);

  async function relockCanonicalAuthAccounts() {
    await ensureUser(adminEmail, adminPassword, "admin");
    await ensureUser(managerEmail, managerPassword, "manager", {
      managerId,
      onlyRole: true,
      fullName: CANONICAL_DEMO_MANAGER_NAME,
    });
    await ensureUser(manager2Email, manager2Password, "manager", { managerId: manager2Id, onlyRole: true });
    await ensureUser(residentEmail, residentPassword, "resident", {
      onlyRole: true,
      metadata: { axis_id: residentAxisId },
      fullName: PRIMARY_RESIDENT_NAME,
    });
    await ensureUser(vendorEmail, vendorPassword, "vendor", {
      onlyRole: true,
      fullName: CANONICAL_DEMO_VENDOR_NAME,
    });
    await ensureUser(everythingEmail, everythingPassword, "manager", {
      managerId: everythingManagerId,
      fullName: EVERYTHING_NAME,
    });
    for (const extraRole of ["admin", "resident", "vendor"]) {
      await must(
        supabase
          .from("profile_roles")
          .upsert({ user_id: everythingUserId, role: extraRole }, { onConflict: "user_id,role" }),
        `profile_roles(relock ${everythingEmail}:${extraRole})`,
      );
    }
  }

  // Repair: any lease/application on test managers whose resident email lacks a
  // resident profile gets provisioned (covers legacy rows or manual approvals).
  async function repairResidentAccountsForTestManagers() {
    const testManagerIds = [managerUserId, manager2UserId];
    const { data: leaseRecords, error: leaseErr } = await supabase
      .from("portal_lease_pipeline_records")
      .select("id, resident_email, resident_user_id, row_data")
      .in("manager_user_id", testManagerIds);
    if (leaseErr) throw new Error(`select leases(repair): ${leaseErr.message}`);

    const { data: appRecords, error: appErr } = await supabase
      .from("manager_application_records")
      .select("id, resident_email, row_data")
      .in("manager_user_id", testManagerIds);
    if (appErr) throw new Error(`select applications(repair): ${appErr.message}`);

    const byEmail = new Map();
    for (const app of appRecords ?? []) {
      const email = String(app.resident_email ?? app.row_data?.email ?? "").trim().toLowerCase();
      if (!email) continue;
      byEmail.set(email, {
        axisId: app.id,
        name: app.row_data?.name ?? email.split("@")[0],
        bucket: app.row_data?.bucket ?? "approved",
        application: app.row_data?.application,
      });
    }
    for (const lease of leaseRecords ?? []) {
      const email = String(lease.resident_email ?? lease.row_data?.residentEmail ?? "").trim().toLowerCase();
      if (!email) continue;
      if (!byEmail.has(email)) {
        byEmail.set(email, {
          axisId: lease.row_data?.axisId ?? lease.id.replace(/^lease_app_/, ""),
          name: lease.row_data?.residentName ?? email.split("@")[0],
          bucket: "approved",
          application: lease.row_data?.application,
        });
      }
    }

    const { data: existingProfiles, error: profileErr } = await supabase
      .from("profiles")
      .select("id, email, role")
      .in(
        "email",
        [...byEmail.keys()],
      );
    if (profileErr) throw new Error(`select profiles(repair): ${profileErr.message}`);
    const profileByEmail = new Map(
      (existingProfiles ?? []).map((row) => [String(row.email).trim().toLowerCase(), row]),
    );

    let repaired = 0;
    for (const [email, info] of byEmail) {
      if (canonicalAuthEmails.has(email)) continue;
      const existing = profileByEmail.get(email);
      if (existing?.role === "resident") continue;
      const claimedAt = NOW.toISOString();
      const userId = await ensureUser(email, AUTO_RESIDENT_PASSWORD, "resident", {
        metadata: {
          axis_id: info.axisId,
          auto_provisioned_resident: false,
          resident_password_claimed_at: claimedAt,
        },
        fullName: info.name,
      });
      await must(
        supabase.from("profiles").upsert(
          {
            id: userId,
            email,
            role: "resident",
            manager_id: info.axisId,
            full_name: info.name,
            application_approved: info.bucket === "approved",
          },
          { onConflict: "id" },
        ),
        `profiles(repair ${email})`,
      );
      const appRecord = (appRecords ?? []).find((a) => String(a.resident_email ?? "").trim().toLowerCase() === email);
      if (appRecord) {
        await must(
          supabase
            .from("manager_application_records")
            .update({
              row_data: {
                ...(appRecord.row_data ?? {}),
                residentUserId: userId,
                setupTokenConsumedAt: claimedAt,
              },
              updated_at: NOW.toISOString(),
            })
            .eq("id", appRecord.id),
          `manager_application_records(repair ${email})`,
        );
      }
      const leaseId = `lease_app_${info.axisId}`;
      const leaseRow = (leaseRecords ?? []).find((l) => l.id === leaseId);
      if (leaseRow) {
        await must(
          supabase
            .from("portal_lease_pipeline_records")
            .update({
              resident_user_id: userId,
              row_data: { ...(leaseRow.row_data ?? {}), residentUserId: userId },
              updated_at: NOW.toISOString(),
            })
            .eq("id", leaseId),
          `portal_lease_pipeline_records(repair ${email})`,
        );
      }
      repaired += 1;
    }
    if (repaired) console.error(`Repaired ${repaired} resident account(s) for lease/application emails`);
  }

  await repairResidentAccountsForTestManagers();
  await relockCanonicalAuthAccounts();

  // ── Cleanup: make every tab agree on the canonical catalog. ───────────────
  const demoPortfolioPropertyIds = [...CANONICAL_DEMO_PORTFOLIO_PROPERTY_IDS];
  const canonicalIds = new Set([...demoPortfolioPropertyIds, ...catalog.map((p) => p.id)]);
  const testManagerIds = [managerUserId, manager2UserId];

  // 0. Ownership drift: a canonical property whose `manager_user_id` moved onto
  //    another account is invisible to every check below (they all scope
  //    `.in("manager_user_id", testManagerIds)`) and would be DELETED by the
  //    account prune in step 6, which removes property rows by stray owner. It
  //    also empties only the Properties tab — Residents / Applications /
  //    Communication read denormalized property labels off application and lease
  //    rows, so they keep looking healthy. The canonical catalog upsert earlier
  //    in this script already rewrites `manager_user_id` for these ids, so on a
  //    full run this is not the first writer; what it adds is the re-read that
  //    fails loudly if the row did not move, and running before the prune can
  //    delete it. It is also the standalone repair
  //    (`npm run test:seed:reclaim-properties`).
  await reclaimCanonicalPropertyOwners(
    supabase,
    Object.fromEntries([
      ...demoPortfolioPropertyIds.map((id) => [id, managerUserId]),
      ...catalog.map((p) => [p.id, p.ownerUserId]),
    ]),
  );

  // 1. Superseded property rows from older seeds — ANY status, not just live.
  //    A leftover `review` row (e.g. the old seedwf_ "Fir Loft 3") reaches the
  //    Calendar property picker (review rows land in extras) but never the
  //    Properties tab (which needs a `mgr-` id prefix) — the tabs disagree.
  const { data: ownedProps, error: ownedPropsErr } = await supabase
    .from("manager_property_records")
    .select("id, status, manager_user_id")
    .in("manager_user_id", testManagerIds);
  if (ownedPropsErr) throw new Error(`select owned properties: ${ownedPropsErr.message}`);
  const staleIds = (ownedProps ?? []).map((r) => r.id).filter((id) => !canonicalIds.has(id));
  if (staleIds.length) {
    await must(supabase.from("manager_property_records").delete().in("id", staleIds), "cleanup manager_property_records");
    console.error(`Cleaned ${staleIds.length} superseded properties: ${staleIds.join(", ")}`);
  }

  // 2. Applications, leases, charges, and rent profiles must reference a
  //    canonical property. This also removes rows whose property no longer
  //    exists at all (e.g. charges pointing at a deleted demo property).
  for (const table of [
    "manager_application_records",
    "portal_lease_pipeline_records",
    "portal_household_charge_records",
    "portal_recurring_rent_profile_records",
  ]) {
    const { data: depRows, error: depSelErr } = await supabase
      .from(table)
      .select("id, property_id")
      .in("manager_user_id", testManagerIds);
    if (depSelErr) throw new Error(`select ${table}: ${depSelErr.message}`);
    const orphanIds = (depRows ?? [])
      .filter((r) => r.property_id && !canonicalIds.has(r.property_id))
      .map((r) => r.id);
    if (orphanIds.length) {
      await must(supabase.from(table).delete().in("id", orphanIds), `cleanup ${table}`);
      console.error(`Cleaned ${orphanIds.length} ${table} rows referencing non-canonical properties`);
    }
  }

  // 3. Calendar events must reference canonical properties too.
  const { data: eventRows, error: eventSelErr } = await supabase
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("record_type", "event")
    .in("manager_user_id", testManagerIds);
  if (eventSelErr) throw new Error(`select schedule events: ${eventSelErr.message}`);
  const danglingEventIds = (eventRows ?? [])
    .filter((r) => {
      const pid = typeof r.row_data?.propertyId === "string" ? r.row_data.propertyId.trim() : "";
      return pid && !canonicalIds.has(pid);
    })
    .map((r) => r.id);
  if (danglingEventIds.length) {
    await must(
      supabase.from("portal_schedule_records").delete().in("id", danglingEventIds),
      "cleanup portal_schedule_records(events)",
    );
    console.error(`Cleaned ${danglingEventIds.length} calendar events referencing non-canonical properties`);
  }

  // 4. Tour-host registry (global KV record): prune entries whose property no
  //    longer exists in manager_property_records at all.
  const { data: registryRec, error: registryErr } = await supabase
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("id", "axis_property_mgr_registry_v1")
    .maybeSingle();
  if (registryErr) throw new Error(`select tour-host registry: ${registryErr.message}`);
  const registryPayload = registryRec?.row_data?.payload;
  if (registryPayload && typeof registryPayload === "object" && !Array.isArray(registryPayload)) {
    const { data: allProps, error: allPropsErr } = await supabase.from("manager_property_records").select("id");
    if (allPropsErr) throw new Error(`select all property ids: ${allPropsErr.message}`);
    const existingIds = new Set((allProps ?? []).map((r) => r.id));
    const prunedKeys = Object.keys(registryPayload).filter((pid) => !existingIds.has(pid));
    if (prunedKeys.length) {
      const nextPayload = { ...registryPayload };
      for (const key of prunedKeys) delete nextPayload[key];
      await must(
        supabase
          .from("portal_schedule_records")
          .update({ row_data: { ...registryRec.row_data, payload: nextPayload } })
          .eq("id", "axis_property_mgr_registry_v1"),
        "prune tour-host registry",
      );
      console.error(`Pruned ${prunedKeys.length} dangling tour-host registry entries: ${prunedKeys.join(", ")}`);
    }
  }

  // 5. Runtime drift on NON-approved seeded applicants: approving one in the
  //    portal mints a lease, move-in charges, and an approved resident profile.
  //    The upserts above reset the application bucket, so those leftovers would
  //    contradict it (a pending applicant with a signed lease). Remove them.
  const nonApproved = people.filter((p) => p.bucket !== "approved");
  const nonApprovedAxisIds = nonApproved.map((p) => p.axisId);
  const nonApprovedEmails = new Set(nonApproved.map((p) => p.email));
  const { data: driftLeases, error: driftLeaseErr } = await supabase
    .from("portal_lease_pipeline_records")
    .select("id")
    .in("id", nonApprovedAxisIds.map((axisId) => `lease_app_${axisId}`));
  if (driftLeaseErr) throw new Error(`select drift leases: ${driftLeaseErr.message}`);
  if (driftLeases?.length) {
    await must(
      supabase.from("portal_lease_pipeline_records").delete().in("id", driftLeases.map((r) => r.id)),
      "cleanup portal_lease_pipeline_records(non-approved)",
    );
    console.error(`Cleaned ${driftLeases.length} leases for non-approved applicants`);
  }
  for (const table of ["portal_household_charge_records", "portal_recurring_rent_profile_records"]) {
    const { data: driftRows, error: driftSelErr } = await supabase
      .from(table)
      .select("id, row_data")
      .in("manager_user_id", testManagerIds);
    if (driftSelErr) throw new Error(`select ${table} drift: ${driftSelErr.message}`);
    const driftIds = (driftRows ?? [])
      .filter((r) => {
        const appId = typeof r.row_data?.applicationId === "string" ? r.row_data.applicationId : "";
        const email = typeof r.row_data?.residentEmail === "string" ? r.row_data.residentEmail.toLowerCase() : "";
        return nonApprovedAxisIds.includes(appId) || nonApprovedEmails.has(email);
      })
      .map((r) => r.id);
    if (driftIds.length) {
      await must(supabase.from(table).delete().in("id", driftIds), `cleanup ${table}(non-approved)`);
      console.error(`Cleaned ${driftIds.length} ${table} rows for non-approved applicants`);
    }
  }
  await must(
    supabase.from("profiles").update({ application_approved: false }).in("manager_id", nonApprovedAxisIds),
    "reset non-approved resident profiles",
  );

  // Stray application rows must not list canonical manager inboxes as residents.
  for (const email of [managerEmail, manager2Email, everythingEmail]) {
    await must(
      supabase
        .from("manager_application_records")
        .delete()
        .eq("resident_email", email),
      `manager_application_records(cleanup canonical resident_email ${email})`,
    );
  }

  // 6. Account prune: the test DB contains ONLY canonical test accounts — the
  //    E2E accounts this seed creates plus the demo-workflow residents
  //    (scripts/seed-demo-manager-workflow.mjs). Anything else (OAuth-test
  //    artifacts, one-off signups, the production admin) is deleted together
  //    with its rows, so strays never accumulate and prod accounts never live
  //    here. assertTestProjectUrl above guarantees this only ever runs against
  //    the dedicated test project.
  const canonicalEmails = new Set([
    adminEmail,
    managerEmail,
    manager2Email,
    residentEmail,
    vendorEmail,
    everythingEmail,
    ...people.map((p) => p.email),
    ...DEMO_WORKFLOW_RESIDENT_EMAILS,
  ]);
  if (canonicalEmails.has(PRODUCTION_ADMIN_EMAIL)) {
    throw new Error(`The production admin (${PRODUCTION_ADMIN_EMAIL}) can never be a canonical test account.`);
  }
  // Tables owning rows keyed by user id (uuid) — kept in sync with the schema;
  // must() fails loudly if a table disappears so the prune never rots silently.
  const PRUNE_USER_ID_TABLES = [
    ["agent_sessions", ["user_id"]],
    ["device_push_tokens", ["user_id"]],
    ["manager_purchases", ["user_id"]],
    ["chart_of_accounts", ["manager_user_id"]],
    ["cosigner_submission_records", ["manager_user_id"]],
    ["ledger_entries", ["manager_user_id", "resident_user_id"]],
    ["manager_application_records", ["manager_user_id"]],
    ["manager_automation_settings", ["manager_user_id"]],
    ["manager_expense_entries", ["manager_user_id"]],
    ["manager_promotion_records", ["manager_user_id"]],
    ["manager_property_records", ["manager_user_id"]],
    ["manager_tax_profiles", ["manager_user_id"]],
    ["manager_vendor_records", ["manager_user_id"]],
    ["portal_household_charge_records", ["manager_user_id", "resident_user_id"]],
    ["portal_inbox_thread_records", ["owner_user_id"]],
    ["portal_lease_pipeline_records", ["manager_user_id", "resident_user_id"]],
    ["portal_pro_relationship_records", ["manager_user_id"]],
    ["portal_recurring_rent_profile_records", ["manager_user_id", "resident_user_id"]],
    ["portal_resident_lease_upload_records", ["resident_user_id"]],
    ["portal_schedule_records", ["manager_user_id"]],
    ["portal_scheduled_inbox_message_records", ["manager_user_id"]],
    ["portal_service_request_records", ["manager_user_id"]],
    ["portal_work_order_records", ["manager_user_id"]],
    ["scheduled_message_overrides", ["manager_user_id"]],
    ["screening_orders", ["manager_user_id"]],
    ["vendor_tax_profiles", ["manager_user_id"]],
    ["profile_roles", ["user_id"]],
    ["profiles", ["id"]],
  ];
  // Tables referencing accounts by email.
  const PRUNE_EMAIL_TABLES = [
    ["ledger_entries", "resident_email"],
    ["manager_application_records", "resident_email"],
    ["manager_purchases", "email"],
    ["portal_bug_feedback_records", "reporter_email"],
    ["portal_household_charge_records", "resident_email"],
    ["portal_inbox_thread_records", "participant_email"],
    ["portal_lease_pipeline_records", "resident_email"],
    ["portal_outbound_mail_records", "recipient_email"],
    ["portal_recurring_rent_profile_records", "resident_email"],
    ["portal_resident_lease_upload_records", "resident_email"],
    ["portal_service_request_records", "resident_email"],
    ["portal_work_order_records", "resident_email"],
  ];
  const { data: allUsersData, error: allUsersErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (allUsersErr) throw new Error(`listUsers(prune): ${allUsersErr.message}`);
  const strayUsers = (allUsersData?.users ?? []).filter(
    (u) => !canonicalEmails.has((u.email ?? "").trim().toLowerCase()),
  );
  const prunedAccounts = [];
  for (const stray of strayUsers) {
    const strayEmail = (stray.email ?? "").trim().toLowerCase();
    for (const [table, cols] of PRUNE_USER_ID_TABLES) {
      for (const col of cols) {
        await must(supabase.from(table).delete().eq(col, stray.id), `prune ${table}.${col}(${strayEmail || stray.id})`);
      }
    }
    if (strayEmail) {
      for (const [table, col] of PRUNE_EMAIL_TABLES) {
        await must(supabase.from(table).delete().eq(col, strayEmail), `prune ${table}.${col}(${strayEmail})`);
      }
    }
    const { error: delUserErr } = await supabase.auth.admin.deleteUser(stray.id);
    if (delUserErr) throw new Error(`deleteUser(${strayEmail || stray.id}): ${delUserErr.message}`);
    prunedAccounts.push(strayEmail || stray.id);
    console.error(`Pruned non-canonical account: ${strayEmail || stray.id}`);
  }
  // Orphan profiles (no auth user, e.g. a half-deleted account) are pruned by
  // email the same way so the admin Accounts view can never resurrect them.
  const { data: allProfiles, error: allProfilesErr } = await supabase.from("profiles").select("id, email");
  if (allProfilesErr) throw new Error(`select profiles(prune): ${allProfilesErr.message}`);
  const orphanProfileIds = (allProfiles ?? [])
    .filter((p) => !canonicalEmails.has((p.email ?? "").trim().toLowerCase()))
    .map((p) => p.id);
  if (orphanProfileIds.length) {
    await must(supabase.from("profile_roles").delete().in("user_id", orphanProfileIds), "prune orphan profile_roles");
    await must(supabase.from("profiles").delete().in("id", orphanProfileIds), "prune orphan profiles");
    console.error(`Pruned ${orphanProfileIds.length} orphan profiles`);
  }

  // Stamp shared Claw agent line on opted-in manager emails (A2P pending).
  // New signups are left alone until Twilio work-number setup is ready.
  const clawStampEmails = new Set(
    (process.env.CLAW_MESSENGER_MANAGER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const email of [managerEmail, everythingEmail]) {
    clawStampEmails.add(email);
  }
  if (clawStampEmails.size > 0) {
    const { data: clawProfiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("email", [...clawStampEmails]);
    for (const row of clawProfiles ?? []) {
      await must(
        supabase
          .from("profiles")
          .update({ sms_from_number: CLAW_AGENT_PHONE, updated_at: new Date().toISOString() })
          .eq("id", row.id),
        `profiles(claw sms_from_number ${row.email})`,
      );
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      testRunId,
      adminId,
      managerUserId,
      managerId,
      manager2UserId,
      manager2Id,
      manager2Email,
      demoPortfolioPropertyIds,
      residentUserId,
      residentEmail,
      residentAxisId,
      applicationId: residentAxisId,
      vendorUserId,
      vendorEmail,
      catalogTours: catalogTours.map((t) => t.id),
      catalogProperties: catalog.map((p) => p.id),
      catalogApplications: people.length,
      catalogLeases: leaseRows.length,
      catalogCharges: chargeRows.length,
      catalogRentProfiles: rentProfileRows.length,
      cleanedStaleProperties: staleIds,
      cleanedDanglingCalendarEvents: danglingEventIds,
      prunedAccounts,
    }),
  );
} catch (err) {
  console.error(err);
  process.exit(1);
}

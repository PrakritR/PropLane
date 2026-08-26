#!/usr/bin/env node
/**
 * Upsert pending + upcoming tour samples for a test manager without a full DB reseed.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-manager-tours.mjs [managerEmail]
 *
 * Default manager: manager@test.proplane.local
 */
import { createClient } from "@supabase/supabase-js";
import { assertTestProjectUrl } from "../tests/helpers/canonical-test-accounts.mjs";

const managerEmail = (process.argv[2]?.trim() || process.env.E2E_MANAGER_EMAIL || "manager@test.proplane.local").toLowerCase();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assertTestProjectUrl(url);

if (!serviceKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const NOW = new Date();
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000);

async function must(promise, label) {
  const { error, data } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

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

async function seedScheduleToursForManager({ managerUserId, hostLabel, properties }) {
  if (!properties.length) return { planned: 0, pending: 0 };
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
    {
      plannedId: `seed-planned-${managerUserId.slice(0, 8)}-c`,
      inquiryId: `seed-pending-${managerUserId.slice(0, 8)}-c`,
      property: properties[2] ?? properties[0],
      daysOut: 1,
      slot: 22,
      guest: { name: "Taylor Nguyen", email: "taylor.tour@axis.local", phone: "+12025550115" },
      pendingGuest: { name: "Morgan Ellis", email: "morgan.tour@axis.local", phone: "+12025550116" },
    },
    {
      plannedId: `seed-planned-${managerUserId.slice(0, 8)}-d`,
      inquiryId: `seed-pending-${managerUserId.slice(0, 8)}-d`,
      property: properties[3] ?? properties[0],
      daysOut: 6,
      slot: 26,
      guest: { name: "Casey Brooks", email: "casey.tour@axis.local", phone: "+12025550117" },
      pendingGuest: { name: "Riley West", email: "riley.tour@axis.local", phone: "+12025550118" },
    },
  ];

  const pendingOnlySpecs = [
    {
      inquiryId: `seed-pending-${managerUserId.slice(0, 8)}-e`,
      property: properties[4] ?? properties[0],
      daysOut: 3,
      slot: 28,
      guest: { name: "Avery Chen", email: "avery.tour@axis.local", phone: "+12025550119" },
    },
    {
      inquiryId: `seed-pending-${managerUserId.slice(0, 8)}-f`,
      property: properties[5] ?? properties[1] ?? properties[0],
      daysOut: 5,
      slot: 30,
      guest: { name: "Quinn Patel", email: "quinn.tour@axis.local", phone: "+12025550120" },
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

  for (const spec of pendingOnlySpecs) {
    const ds = isoDate(daysFromNow(spec.daysOut));
    const pendingStart = slotIsoFromDateStr(ds, spec.slot);
    const pendingEnd = slotIsoFromDateStr(ds, spec.slot + 2);
    const pendingSlotKey = `${ds}:${spec.slot}`;
    partnerInquiries.push({
      id: spec.inquiryId,
      name: spec.guest.name,
      email: spec.guest.email,
      phone: spec.guest.phone,
      notes: "Looking for a quiet room with natural light.",
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

  return { planned: plannedEvents.length, pending: partnerInquiries.length };
}

const { data: profile, error: profileError } = await supabase
  .from("profiles")
  .select("id, full_name")
  .ilike("email", managerEmail)
  .maybeSingle();
if (profileError) throw new Error(`profiles: ${profileError.message}`);
if (!profile?.id) {
  console.error(`No profile for ${managerEmail}`);
  process.exit(1);
}

const { data: propertyRows, error: propertyError } = await supabase
  .from("manager_property_records")
  .select("id, row_data")
  .eq("manager_user_id", profile.id)
  .in("status", ["live", "pending", "review"]);
if (propertyError) throw new Error(`manager_property_records: ${propertyError.message}`);

const properties = (propertyRows ?? []).map((row) => ({
  id: row.id,
  name:
    row.row_data?.property_data?.buildingName?.trim() ||
    row.row_data?.submission?.propertyName?.trim() ||
    row.id,
}));

if (!properties.length) {
  console.error(`No listing properties for ${managerEmail}`);
  process.exit(1);
}

const hostLabel = profile.full_name?.trim() || "Test Manager";
const result = await seedScheduleToursForManager({
  managerUserId: profile.id,
  hostLabel,
  properties,
});

console.log(
  `Seeded ${result.planned} upcoming + ${result.pending} pending tours for ${managerEmail} across ${properties.length} properties.`,
);

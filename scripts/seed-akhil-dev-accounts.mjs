#!/usr/bin/env node
/**
 * Recreates the personal Akhil dogfood pair on the DEV/TEST Supabase project
 * and seeds three live listings with five fake residents plus
 * akhil-resident@prop-lane.space on one of those homes.
 *
 *   node --env-file=.env.local --env-file=.env scripts/seed-akhil-dev-accounts.mjs
 *
 * Refuses to run against production.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { isProductionSupabaseProjectUrl } from "../tests/helpers/canonical-production-accounts.mjs";
import {
  DOGFOOD_ACCOUNT_PASSWORD,
  DOGFOOD_MANAGER_EMAIL,
  DOGFOOD_RESIDENT_AXIS_ID,
  DOGFOOD_RESIDENT_EMAIL,
  TEST_SUPABASE_PROJECT_REF,
} from "../tests/helpers/canonical-test-accounts.mjs";
import { buildSeedLeaseHtml } from "../tests/helpers/build-seed-lease-html.mjs";
import {
  buildSeedChargesForPerson,
  buildSeedRentProfileForPerson,
  householdChargeDbRow,
  rentProfileDbRow,
} from "../tests/helpers/build-seed-catalog-charges.mjs";

const DEV_REF = TEST_SUPABASE_PROJECT_REF;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const ref = new URL(url).hostname.split(".")[0];
if (isProductionSupabaseProjectUrl(url) || ref !== DEV_REF) {
  console.error(`Refusing to seed: expected dev project ${DEV_REF}, got ${ref}.`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const NOW = new Date();
const PASSWORD = DOGFOOD_ACCOUNT_PASSWORD;
const MANAGER_EMAIL = DOGFOOD_MANAGER_EMAIL;
const RESIDENT_EMAIL = DOGFOOD_RESIDENT_EMAIL;
const MANAGER_NAME = "Akhil Manager";
const RESIDENT_NAME = "Akhil Resident";
const RESIDENT_AXIS_ID = DOGFOOD_RESIDENT_AXIS_ID;

function daysFromNow(n) {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function usd(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

async function must(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function findUserIdByEmail(email) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureUser(email, password, role, { managerId = null, fullName = null, metadata = {} } = {}) {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, ...metadata },
  });

  let userId;
  if (createErr) {
    if (!createErr.message.toLowerCase().includes("already")) {
      throw new Error(`createUser ${email}: ${createErr.message}`);
    }
    userId = await findUserIdByEmail(email);
    if (!userId) throw new Error(`User ${email} exists but was not found.`);
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      user_metadata: { role, ...metadata },
    });
    if (updateErr) throw new Error(`updateUserById ${email}: ${updateErr.message}`);
    console.log(`  updated ${role} ${email}`);
  } else {
    userId = created.user.id;
    console.log(`  created ${role} ${email}`);
  }

  await must(
    supabase.from("profiles").upsert(
      {
        id: userId,
        email,
        role,
        ...(managerId ? { manager_id: managerId } : {}),
        full_name: fullName ?? email.split("@")[0],
        application_approved: role === "resident",
      },
      { onConflict: "id" },
    ),
    `profiles(${email})`,
  );
  await must(
    supabase.from("profile_roles").upsert({ user_id: userId, role }, { onConflict: "user_id,role" }),
    `profile_roles(${email})`,
  );
  return userId;
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

function buildBathrooms(p) {
  const roomIds = p.rooms.map((r) => r.id);
  return [
    {
      id: `${p.id}-bath-main`,
      name: "Main hall bath",
      location: "Hallway",
      amenitiesText: "Shower\nToilet\nBathtub",
      photoDataUrls: [],
      videoDataUrl: null,
      shower: true,
      toilet: true,
      bathtub: true,
      assignedRoomIds: roomIds,
      accessKindByRoomId: Object.fromEntries(roomIds.map((id) => [id, "shared"])),
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
    bathrooms: buildBathrooms(p),
    bundles: [],
    quickFacts: [],
  };
}

function buildApplication(p) {
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

function leaseHtmlStub(p) {
  return (
    `<section class="lease-doc"><h1>Residential Lease Agreement</h1>` +
    `<p><strong>Tenant:</strong> ${p.name}</p><p><strong>Premises:</strong> ${p.prop.name} · ${p.room.name}</p>` +
    `<p><strong>Monthly Rent:</strong> ${usd(p.rent)}</p><p><strong>Term:</strong> 12 months</p>` +
    `<p>This agreement is generated from the approved rental application and governed by Washington State (Seattle) law.</p></section>`
  );
}

function buildLeaseHtml(p) {
  try {
    return buildSeedLeaseHtml({
      application: buildApplication(p),
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
    console.warn(`  lease html fallback for ${p.axisId}: ${err.message}`);
    return leaseHtmlStub(p);
  }
}

function buildLeaseRow(p) {
  const genIso = daysFromNow(-4).toISOString();
  const sentIso = daysFromNow(-3).toISOString();
  const resSignIso = daysFromNow(-2).toISOString();
  const mgrSignIso = daysFromNow(-1).toISOString();
  const resSig = { name: p.name, signedAtIso: resSignIso, role: "resident" };
  return {
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
    application: buildApplication(p),
    generatedHtml: buildLeaseHtml(p),
    generatedAtIso: genIso,
    managerUploadedPdf: null,
    thread: [],
    managerSignature: { name: MANAGER_NAME, signedAtIso: mgrSignIso, role: "manager" },
    residentSignature: resSig,
    signatureName: p.name,
    signedAtIso: resSignIso,
    residentSignedAt: resSignIso,
    managerSignedAt: mgrSignIso,
    adminReviewRequestedAt: null,
    sentToResidentAt: sentIso,
    fullySignedAt: mgrSignIso,
    voidedAt: null,
    bucket: "signed",
    status: "Fully Signed",
    stageLabel: "Signed",
    currentActorRole: "system",
  };
}

console.log(`Seeding into ${ref} (dev/test)`);

const managerUserId = await ensureUser(MANAGER_EMAIL, PASSWORD, "manager", {
  fullName: MANAGER_NAME,
});
const { data: managerProfile } = await supabase
  .from("profiles")
  .select("manager_id")
  .eq("id", managerUserId)
  .maybeSingle();
const managerId = managerProfile?.manager_id?.trim() || `mgr_${managerUserId.slice(0, 8)}`;
await must(
  supabase
    .from("profiles")
    .update({ manager_id: managerId, full_name: MANAGER_NAME, role: "manager", application_approved: true })
    .eq("id", managerUserId),
  "profiles(manager id)",
);

const { data: existingPurchase } = await supabase
  .from("manager_purchases")
  .select("id")
  .eq("user_id", managerUserId)
  .maybeSingle();
const purchasePatch = {
  tier: "business",
  billing: "portal",
  promo_code: "FREE100",
  paid_at: NOW.toISOString(),
  email: MANAGER_EMAIL,
  user_id: managerUserId,
};
if (existingPurchase?.id) {
  await must(
    supabase.from("manager_purchases").update(purchasePatch).eq("id", existingPurchase.id),
    "manager_purchases(update)",
  );
} else {
  await must(
    supabase.from("manager_purchases").upsert(
      {
        ...purchasePatch,
        manager_id: managerId,
        stripe_checkout_session_id: `seed_akhil_${managerId.replace(/[^A-Za-z0-9]+/g, "_")}`,
      },
      { onConflict: "manager_id" },
    ),
    "manager_purchases(insert)",
  );
}

const properties = [
  {
    id: "mgr-akhil-fremont",
    name: "Fremont Craftsman",
    address: "412 N 36th St, Seattle, WA 98103",
    zip: "98103",
    neighborhood: "Fremont",
    tagline: "Shared craftsman near the canal.",
    overview:
      "A renovated 2-room craftsman in Fremont with a shared kitchen, backyard, and a short walk to the canal path.",
    structureNote: "2-story craftsman",
    petFriendly: true,
    deposit: 1850,
    ownerUserId: managerUserId,
    rooms: [
      room(1, "2nd floor", 1850, "South-facing room with queen bed and desk.", { name: "Room A" }),
      room(2, "2nd floor", 1750, "Garden-view room with full bed.", { name: "Room B" }),
    ],
  },
  {
    id: "mgr-akhil-ballard",
    name: "Ballard House",
    address: "5408 Ballard Ave NW, Seattle, WA 98107",
    zip: "98107",
    neighborhood: "Ballard",
    tagline: "Cozy shared house near the market.",
    overview: "A 2-room shared house in Ballard with backyard, shared kitchen, and walkable restaurants.",
    structureNote: "2-story house",
    petFriendly: true,
    deposit: 1100,
    ownerUserId: managerUserId,
    rooms: [
      room(1, "1st floor", 1100, "Garden-level room.", { name: "Room 1" }),
      room(2, "2nd floor", 1150, "Front-facing room.", { name: "Room 2" }),
    ],
  },
  {
    id: "mgr-akhil-capitol",
    name: "Capitol Hill Loft",
    address: "1212 E Pine St, Seattle, WA 98122",
    zip: "98122",
    neighborhood: "Capitol Hill",
    tagline: "Bright shared loft near light rail.",
    overview: "A 2-room shared loft on Capitol Hill with rooftop access and a short walk to the streetcar.",
    structureNote: "3-story loft building",
    petFriendly: false,
    deposit: 1300,
    ownerUserId: managerUserId,
    rooms: [
      room(1, "3rd floor", 1300, "Top-floor room with skyline view.", { name: "Loft A" }),
      room(2, "2nd floor", 1250, "Quiet mid-floor room.", { name: "Loft B" }),
    ],
  },
];
const propById = new Map(properties.map((p) => [p.id, p]));

const peopleDefs = [
  {
    axisId: RESIDENT_AXIS_ID,
    first: "Akhil",
    last: "Resident",
    email: RESIDENT_EMAIL,
    propId: "mgr-akhil-fremont",
    roomId: "room-1",
    income: 102000,
    password: PASSWORD,
  },
  {
    axisId: "AXIS-AKHILM1",
    first: "Maya",
    last: "Chen",
    email: "maya.chen.akhil@test.proplane.local",
    propId: "mgr-akhil-fremont",
    roomId: "room-2",
    income: 96000,
  },
  {
    axisId: "AXIS-AKHILM2",
    first: "Marcus",
    last: "Lee",
    email: "marcus.lee.akhil@test.proplane.local",
    propId: "mgr-akhil-ballard",
    roomId: "room-1",
    income: 88000,
  },
  {
    axisId: "AXIS-AKHILM3",
    first: "Sofia",
    last: "Diaz",
    email: "sofia.diaz.akhil@test.proplane.local",
    propId: "mgr-akhil-ballard",
    roomId: "room-2",
    income: 91000,
  },
  {
    axisId: "AXIS-AKHILM4",
    first: "Liam",
    last: "Foster",
    email: "liam.foster.akhil@test.proplane.local",
    propId: "mgr-akhil-capitol",
    roomId: "room-1",
    income: 98000,
  },
  {
    axisId: "AXIS-AKHILM5",
    first: "Olivia",
    last: "Brooks",
    email: "olivia.brooks.akhil@test.proplane.local",
    propId: "mgr-akhil-capitol",
    roomId: "room-2",
    income: 87000,
  },
];

const people = peopleDefs.map((p, i) => {
  const prop = propById.get(p.propId);
  const roomDef = prop.rooms.find((r) => r.id === p.roomId);
  return {
    ...p,
    index: i,
    name: `${p.first} ${p.last}`,
    password: p.password ?? PASSWORD,
    bucket: "approved",
    leaseStage: "signed",
    prop,
    room: roomDef,
    rent: roomDef.rent,
    roomChoice: `${p.propId}::${p.roomId}`,
  };
});

for (const p of people) {
  p.residentUserId = await ensureUser(p.email, p.password, "resident", {
    managerId: p.axisId,
    fullName: p.name,
    metadata: { axis_id: p.axisId },
  });
}

const propertyIds = properties.map((p) => p.id);
const axisIds = people.map((p) => p.axisId);
const emails = people.map((p) => p.email);

const tablesByManager = [
  "manager_property_records",
  "manager_application_records",
  "portal_household_charge_records",
  "portal_recurring_rent_profile_records",
  "portal_lease_pipeline_records",
];
for (const table of tablesByManager) {
  await must(supabase.from(table).delete().eq("manager_user_id", managerUserId), `clean ${table}`);
}

const propertyRows = properties.map((p) => {
  const submission = buildListingSubmission(p);
  const rents = p.rooms.map((r) => r.rent);
  const minRent = Math.min(...rents);
  const maxRent = Math.max(...rents);
  const rentLabel =
    minRent === maxRent
      ? `$${minRent.toLocaleString("en-US")} / mo`
      : `$${minRent.toLocaleString("en-US")}–$${maxRent.toLocaleString("en-US")} / mo`;
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
      beds: p.rooms.length,
      baths: 1,
      rentLabel,
      available: "Now",
      petFriendly: p.petFriendly,
      buildingId: `${p.id}-bld`,
      buildingName: p.name,
      unitLabel: `${p.rooms.length} rooms`,
      mapLat: 47.6505,
      mapLng: -122.35,
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
    },
    updated_at: NOW.toISOString(),
  };
});
await must(
  supabase.from("manager_property_records").upsert(propertyRows, { onConflict: "id" }),
  "manager_property_records",
);

const applicationRows = people.map((p) => ({
  id: p.axisId,
  manager_user_id: managerUserId,
  resident_email: p.email,
  property_id: p.propId,
  assigned_property_id: p.propId,
  row_data: {
    id: p.axisId,
    axisId: p.axisId,
    bucket: "approved",
    stage: "Approved - placed",
    detail: `Approved for ${p.room.name}`,
    email: p.email,
    name: p.name,
    property: p.prop.name,
    application: buildApplication(p),
    backgroundCheck: {
      provider: "checkr",
      candidateId: `seed-cand-${p.axisId.toLowerCase()}`,
      reportId: `seed-report-${p.axisId.toLowerCase()}`,
      packageSlug: "test_pro_criminal",
      status: "complete",
      result: "clear",
      assessment: "eligible",
      orderedAt: daysFromNow(-2).toISOString(),
      completedAt: daysFromNow(-1).toISOString(),
      simulated: true,
    },
    backgroundCheckStatus: "passed",
    managerUserId,
    propertyId: p.propId,
    residentUserId: p.residentUserId,
    assignedPropertyId: p.propId,
    assignedRoomChoice: p.roomChoice,
    signedMonthlyRent: p.rent,
  },
  updated_at: NOW.toISOString(),
}));
await must(
  supabase.from("manager_application_records").upsert(applicationRows, { onConflict: "id" }),
  "manager_application_records",
);

const leaseRows = people.map((p) => {
  const row = buildLeaseRow(p);
  return {
    id: row.id,
    manager_user_id: managerUserId,
    resident_user_id: p.residentUserId,
    resident_email: p.email,
    property_id: p.propId,
    status: row.bucket,
    row_data: { ...row, residentUserId: p.residentUserId },
    updated_at: NOW.toISOString(),
  };
});
await must(
  supabase.from("portal_lease_pipeline_records").upsert(leaseRows, { onConflict: "id" }),
  "portal_lease_pipeline_records",
);

const leaseEndIso = isoDate(daysFromNow(375));
const chargeRows = [];
const rentProfileRows = [];
for (const p of people) {
  const charges = buildSeedChargesForPerson(p, { now: NOW, moveInDueLabel: isoDate(daysFromNow(10)) });
  chargeRows.push(...charges.map(householdChargeDbRow));
  const profile = buildSeedRentProfileForPerson(p, { now: NOW, leaseEndIso });
  if (profile) rentProfileRows.push(rentProfileDbRow(profile));
}
await must(
  supabase.from("portal_household_charge_records").upsert(chargeRows, { onConflict: "id" }),
  "portal_household_charge_records",
);
await must(
  supabase.from("portal_recurring_rent_profile_records").upsert(rentProfileRows, { onConflict: "id" }),
  "portal_recurring_rent_profile_records",
);

console.log(`
Seeded into ${ref}

  manager   ${MANAGER_EMAIL} / ${PASSWORD}
  resident  ${RESIDENT_EMAIL} / ${PASSWORD}   (${RESIDENT_AXIS_ID} @ Fremont Craftsman · Room A)

  properties
    ${properties.map((p) => `${p.id} — ${p.name}`).join("\n    ")}

  residents
    ${people.map((p) => `${p.email} / ${p.password}  →  ${p.prop.name} · ${p.room.name}`).join("\n    ")}

  rows  properties ${propertyIds.length}  apps ${axisIds.length}  leases ${leaseRows.length}  charges ${chargeRows.length}
`);
void emails;

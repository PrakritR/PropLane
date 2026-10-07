#!/usr/bin/env node
/**
 * Seeds the SHOWCASE manager the App Store screenshots are shot as.
 *
 *   npm run app-store:seed
 *
 * One dedicated manager (default showcase.manager@northgaterooms.example) on the dev/test
 * Supabase project, with a portfolio that reads like a real small landlord: 6 houses with
 * real Seattle street addresses, 15 rooms, 13 of them let (87% occupancy), this month's rent
 * ~96% collected, nothing overdue, applicants, current residents, leases in four stages,
 * tours, a populated inbox, and a work number on file so no "Phone number not set up" row.
 *
 * Idempotent: it deletes and re-writes ONLY rows owned by the showcase manager, so a re-run
 * lands on exactly the same data. It never touches manager2@, the e2e seed, or anyone else.
 * It refuses any Supabase project but the dev/test one (assertTestProjectUrl), and refuses
 * production outright. No listing photo is created: rooms and houses keep the house glyph.
 *
 * Credentials: SHOT_EMAIL / SHOT_PASSWORD in .env.local (gitignored). The first run mints a
 * random password and appends both; later runs reuse them. The generator reads the same two
 * variables:  npm run app-store:shots -- --base http://localhost:3000
 *
 * `npm run test:seed` prunes non-canonical accounts, including this one: re-run this script
 * after a full reseed.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { assertTestProjectUrl } from "../tests/helpers/canonical-test-accounts.mjs";
import { isProductionSupabaseProjectUrl } from "../tests/helpers/canonical-production-accounts.mjs";
import { buildSeedLeaseHtml } from "../tests/helpers/build-seed-lease-html.mjs";
import {
  buildSeedServiceRequestsForPerson,
  buildSeedWorkOrdersForPerson,
  serviceRequestDbRow,
  workOrderDbRow,
} from "../tests/helpers/build-seed-resident-portal-extras.mjs";
import {
  chargeKeyPart,
  householdChargeDbRow,
  rentProfileDbRow,
} from "../tests/helpers/build-seed-catalog-charges.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENV_LOCAL = resolve(REPO, ".env.local");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run via `npm run app-store:seed`.");
  process.exit(1);
}
if (isProductionSupabaseProjectUrl(url)) {
  console.error("Refusing to seed the production Supabase project.");
  process.exit(1);
}
assertTestProjectUrl(url); // dev/test project only

/** The dev project drops the odd connection; retry a thrown fetch instead of leaving half a portfolio. */
async function retryingFetch(input, init) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: retryingFetch },
});

const NOW = new Date();
const RUN_TAG = "app-store-showcase";
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000);
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const monthKey = (d) => d.toISOString().slice(0, 7);
/** First day of the month `back` months before now, at noon UTC. */
const monthStart = (back) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - back, 1, 12));

async function must(promise, label) {
  const { error, data } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

// ── Credentials ─────────────────────────────────────────────────────────────

function readEnvLocal(key) {
  if (!existsSync(ENV_LOCAL)) return "";
  const line = readFileSync(ENV_LOCAL, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}

const MANAGER_EMAIL = (process.env.SHOT_EMAIL?.trim() || readEnvLocal("SHOT_EMAIL") || "showcase.manager@northgaterooms.example").toLowerCase();
let MANAGER_PASSWORD = process.env.SHOT_PASSWORD?.trim() || readEnvLocal("SHOT_PASSWORD");
let mintedPassword = false;
if (!MANAGER_PASSWORD) {
  MANAGER_PASSWORD = `Ngt-${randomBytes(12).toString("base64url")}9!`;
  mintedPassword = true;
}
const MANAGER_NAME = "Dana Whitfield";
const BUSINESS_NAME = "Northgate Rooms LLC";
const WORKSPACE_NAME = "Northgate Rooms";
const MANAGER_PHONE = "+12065550142";
const WORK_NUMBER = "+12065550143";

async function ensureManagerUser() {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: MANAGER_EMAIL,
    password: MANAGER_PASSWORD,
    email_confirm: true,
    user_metadata: { role: "manager" },
  });
  let userId;
  if (createErr) {
    if (!createErr.message.toLowerCase().includes("already")) throw new Error(`createUser: ${createErr.message}`);
    let found = null;
    for (let page = 1; page <= 20 && !found; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(`listUsers: ${error.message}`);
      found = data.users.find((u) => u.email?.toLowerCase() === MANAGER_EMAIL) ?? null;
      if (data.users.length < 1000) break;
    }
    if (!found) throw new Error(`${MANAGER_EMAIL} exists but was not found.`);
    userId = found.id;
    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
      password: MANAGER_PASSWORD,
      user_metadata: { ...(found.user_metadata ?? {}), role: "manager" },
    });
    if (updErr) throw new Error(`updateUserById: ${updErr.message}`);
  } else {
    userId = created.user.id;
  }
  return userId;
}

// ── Portfolio definition ────────────────────────────────────────────────────

const room = (n, name, rent, detail, extras = {}) => ({ id: `room-${n}`, name, floor: extras.floor ?? "2nd floor", rent, detail, ...extras });

const PROPERTIES = [
  {
    id: "mgr-ngt-ravenna",
    name: "Ravenna Craftsman",
    address: "5412 17th Ave NE, Seattle, WA",
    zip: "98105",
    neighborhood: "Ravenna",
    tagline: "Sunny craftsman a few blocks from Green Lake.",
    overview: "A three-bedroom craftsman in Ravenna with a big kitchen, a fenced yard, and a short walk to Green Lake and the 45 bus.",
    structure: "2-story craftsman",
    pets: true,
    deposit: 1150,
    rooms: [
      room(1, "Room A", 1150, "Front room with a bay window.", { floor: "Main floor" }),
      room(2, "Room B", 1195, "Large corner room with two beds.", { occupancyCapacity: 2 }),
      room(3, "Room C", 1125, "Quiet back room over the yard."),
    ],
  },
  {
    id: "mgr-ngt-ballard",
    name: "Ballard Bungalow",
    address: "6718 24th Ave NW, Seattle, WA",
    zip: "98117",
    neighborhood: "Ballard",
    tagline: "Bungalow near the Ballard Locks.",
    overview: "A renovated bungalow in Ballard with in-unit laundry and a covered porch, walking distance to the Locks and Market Street.",
    structure: "1.5-story bungalow",
    pets: true,
    deposit: 1225,
    rooms: [
      room(1, "Room 1", 1225, "Bright room facing the street.", { floor: "Main floor" }),
      room(2, "Room 2", 1260, "Corner room with extra closet space."),
      room(3, "Room 3", 1190, "Quiet room at the back of the house."),
    ],
  },
  {
    id: "mgr-ngt-fremont",
    name: "Fremont Flats",
    address: "3614 Phinney Ave N, Seattle, WA",
    zip: "98103",
    neighborhood: "Fremont",
    tagline: "Two-room flat steps from the Fremont canal.",
    overview: "A furnished two-bedroom flat in Fremont, a block from the Burke-Gilman Trail, with fast Wi-Fi and a shared deck.",
    structure: "Unit in a fourplex",
    pets: false,
    deposit: 1340,
    rooms: [room(1, "Room 1", 1340, "Large room with a desk nook.", { floor: "Main floor" }), room(2, "Room 2", 1290, "Cozy room with a skylight.")],
  },
  {
    id: "mgr-ngt-beacon",
    name: "Beacon Hill House",
    address: "2915 15th Ave S, Seattle, WA",
    zip: "98144",
    neighborhood: "Beacon Hill",
    tagline: "Light-rail house with a big shared kitchen.",
    overview: "A three-bedroom house on Beacon Hill, ten minutes from Beacon Hill light rail, with a big shared kitchen and a garden.",
    structure: "2-story house",
    pets: true,
    deposit: 985,
    rooms: [
      room(1, "Room 1", 985, "Sunny room with a closet.", { floor: "Main floor" }),
      room(2, "Room 2", 1010, "Large room with garden views."),
      room(3, "Room 3", 995, "Quiet room next to the bath."),
    ],
  },
  {
    id: "mgr-ngt-capitol",
    name: "Capitol Hill Loft",
    address: "1420 E Union St, Seattle, WA",
    zip: "98122",
    neighborhood: "Capitol Hill",
    tagline: "Top-floor loft on Capitol Hill.",
    overview: "A top-floor two-bedroom loft on Capitol Hill with tall windows and a rooftop deck, walking distance to light rail and Pike/Pine.",
    structure: "Loft in a 4-story building",
    pets: false,
    deposit: 1495,
    rooms: [room(1, "Room 1", 1495, "Loft room with city views.", { floor: "4th floor" }), room(2, "Room 2", 1450, "Corner room with a private balcony.", { floor: "4th floor" })],
  },
  {
    id: "mgr-ngt-columbia",
    name: "Columbia City Duplex",
    address: "4807 Rainier Ave S, Seattle, WA",
    zip: "98118",
    neighborhood: "Columbia City",
    tagline: "Duplex on Rainier Ave, near the light rail.",
    overview: "Half of a duplex in Columbia City with a shared kitchen and a bike room, two blocks from the light rail station.",
    structure: "Duplex",
    pets: true,
    deposit: 640,
    rooms: [room(1, "Small room", 640, "Compact room with a built-in desk.", { floor: "Main floor" }), room(2, "Room 2", 960, "Roomy second bedroom.")],
  },
];
const PROP_BY_ID = new Map(PROPERTIES.map((p) => [p.id, p]));

/**
 * People. `stage` for approved rows is the lease stage. `signedBack` = whole months ago the
 * lease was signed (0 = this month). `rentDueDay` is a rent due on that day each month: this month's is not yet due, so it stays unpaid.
 *
 * Money is rent only: no application fee, deposit, move-in fee or utilities are configured on the
 * listings, because the app bills each of those itself the moment it loads a signed lease and
 * would leave a pile of pending/overdue charges on the showcase books.
 */
const PEOPLE = [
  // 13 current residents (fully signed leases = occupancy)
  { first: "Priya", last: "Raman", prop: "mgr-ngt-ravenna", room: 1, bucket: "approved", stage: "signed", signedBack: 6, income: 98000 },
  { first: "Daniel", last: "Okafor", prop: "mgr-ngt-ravenna", room: 2, bucket: "approved", stage: "signed", signedBack: 5, income: 91000 },
  { first: "Hannah", last: "Weiss", prop: "mgr-ngt-ravenna", room: 3, bucket: "approved", stage: "signed", signedBack: 4, income: 87000 },
  { first: "Marcus", last: "Bell", prop: "mgr-ngt-ballard", room: 1, bucket: "approved", stage: "signed", signedBack: 6, income: 104000 },
  { first: "Elena", last: "Rossi", prop: "mgr-ngt-ballard", room: 2, bucket: "approved", stage: "signed", signedBack: 5, income: 96000 },
  { first: "Tyler", last: "Nguyen", prop: "mgr-ngt-ballard", room: 3, bucket: "approved", stage: "signed", signedBack: 3, income: 89000 },
  { first: "Sophie", last: "Laurent", prop: "mgr-ngt-fremont", room: 1, bucket: "approved", stage: "signed", signedBack: 4, income: 112000 },
  { first: "Jacob", last: "Miller", prop: "mgr-ngt-fremont", room: 2, bucket: "approved", stage: "signed", signedBack: 2, income: 94000 },
  { first: "Aisha", last: "Rahman", prop: "mgr-ngt-beacon", room: 1, bucket: "approved", stage: "signed", signedBack: 3, income: 84000 },
  { first: "Luis", last: "Herrera", prop: "mgr-ngt-beacon", room: 2, bucket: "approved", stage: "signed", signedBack: 2, income: 82000 },
  { first: "Grace", last: "Kim", prop: "mgr-ngt-capitol", room: 1, bucket: "approved", stage: "signed", signedBack: 0, income: 118000 },
  { first: "Owen", last: "Fitzgerald", prop: "mgr-ngt-capitol", room: 2, bucket: "approved", stage: "signed", signedBack: 0, income: 109000 },
  { first: "Nina", last: "Patel", prop: "mgr-ngt-columbia", room: 1, bucket: "approved", stage: "signed", signedBack: 2, income: 76000, rentDueDay: 15 },
  // Three leases still moving through the pipeline (the rooms they take are open today)
  { first: "Omar", last: "Haddad", prop: "mgr-ngt-beacon", room: 3, bucket: "approved", stage: "manager", income: 86000 },
  { first: "Chloe", last: "Bennett", prop: "mgr-ngt-columbia", room: 2, bucket: "approved", stage: "resident_sign", income: 79000 },
  { first: "Ethan", last: "Brooks", prop: "mgr-ngt-ravenna", room: 2, bucket: "approved", stage: "manager_sign", income: 93000 },
  // Eight applications waiting for a decision
  { first: "Zoe", last: "Martin", prop: "mgr-ngt-beacon", room: 3, bucket: "pending", income: 81000 },
  { first: "Caleb", last: "Wright", prop: "mgr-ngt-columbia", room: 2, bucket: "pending", income: 77000 },
  { first: "Isabel", last: "Costa", prop: "mgr-ngt-ravenna", room: 2, bucket: "pending", income: 88000 },
  { first: "Noah", last: "Peterson", prop: "mgr-ngt-fremont", room: 1, bucket: "pending", income: 99000 },
  { first: "Leah", last: "Goldberg", prop: "mgr-ngt-capitol", room: 2, bucket: "pending", income: 105000 },
  { first: "Andre", last: "Jackson", prop: "mgr-ngt-ballard", room: 1, bucket: "pending", income: 92000 },
  { first: "Mei", last: "Tanaka", prop: "mgr-ngt-beacon", room: 3, bucket: "pending", income: 83000 },
  { first: "Samir", last: "Desai", prop: "mgr-ngt-columbia", room: 2, bucket: "pending", income: 78000 },
  // One decided application
  { first: "Brandon", last: "Hughes", prop: "mgr-ngt-ballard", room: 3, bucket: "rejected", income: 41000, rejectReason: "Income below 2.5x rent." },
].map((p, i) => {
  const prop = PROP_BY_ID.get(p.prop);
  const roomDef = prop.rooms.find((r) => r.id === `room-${p.room}`);
  const name = `${p.first} ${p.last}`;
  const slug = `${p.first}.${p.last}`.toLowerCase();
  return {
    ...p,
    index: i,
    name,
    email: `${slug}@example.com`, // reserved domain: can never be a real inbox
    axisId: `AXIS-NGT${String(i + 1).padStart(3, "0")}`,
    propDef: prop,
    roomDef,
    roomChoice: `${p.prop}::room-${p.room}`,
    rent: roomDef.rent,
  };
});

const TOURS = [
  { name: "Jamie Rivera", prop: "mgr-ngt-beacon", daysOut: 1, slot: 22, status: "pending" },
  { name: "Sam Ortiz", prop: "mgr-ngt-columbia", daysOut: 2, slot: 24, status: "pending" },
  { name: "Alex Kim", prop: "mgr-ngt-ravenna", daysOut: 2, slot: 28, status: "pending" },
  { name: "Taylor Brooks", prop: "mgr-ngt-capitol", daysOut: 3, slot: 20, status: "pending" },
  { name: "Morgan Ellis", prop: "mgr-ngt-ballard", daysOut: 4, slot: 26, status: "pending" },
  { name: "Riley West", prop: "mgr-ngt-fremont", daysOut: 5, slot: 30, status: "pending" },
  { name: "Casey Morgan", prop: "mgr-ngt-beacon", daysOut: 1, slot: 26, status: "confirmed" },
  { name: "Avery Chen", prop: "mgr-ngt-columbia", daysOut: 3, slot: 24, status: "confirmed" },
].map((t, i) => ({ ...t, email: `${t.name.toLowerCase().replace(/\s+/g, ".")}@example.com`, phone: `+1206555${String(1100 + i * 7).padStart(4, "0")}` }));

// ── Row builders ────────────────────────────────────────────────────────────

function listingSubmission(p) {
  const roomIds = p.rooms.map((r) => r.id);
  return {
    v: 1,
    buildingName: p.name,
    address: p.address,
    zip: p.zip,
    neighborhood: p.neighborhood,
    homeStructureNote: p.structure,
    listingPlaceCategoryId: "private_room",
    tagline: p.tagline,
    petFriendly: p.pets,
    houseOverview: p.overview,
    houseRulesText: "Quiet hours 10pm-8am. No smoking anywhere on the premises. Overnight guests limited to 3 nights per week. Clean shared spaces after use.",
    housePhotoDataUrls: [],
    allowedLeaseTerms: ["12 months"],
    leaseTermsBody: "Available lease lengths: 12 months.",
    applicationFee: "",
    securityDeposit: "",
    moveInFee: "",
    paymentAtSigningIncludes: [],
    houseCostsDetail: "",
    parkingMonthly: "",
    hoaMonthly: "",
    otherMonthlyFees: "",
    sharedSpaces: [
      { id: "shared-kitchen", name: "Kitchen", location: "Main floor", detail: "Full kitchen shared by all residents.", amenitiesText: "Refrigerator\nDishwasher\nGas range", photoDataUrls: [], videoDataUrl: null, roomAccessIds: roomIds },
      { id: "shared-living", name: "Living room", location: "Main floor", detail: "Furnished living room with a smart TV.", amenitiesText: "Sofa\nSmart TV", photoDataUrls: [], videoDataUrl: null, roomAccessIds: roomIds },
    ],
    amenitiesText: "In-unit laundry\nFast Wi-Fi\nFurnished rooms",
    rooms: p.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      floor: r.floor,
      monthlyRent: r.rent,
      ...(r.occupancyCapacity ? { occupancyCapacity: r.occupancyCapacity } : {}),
      availability: "Now",
      moveInAvailableDate: isoDate(NOW),
      moveInInstructions: "Lockbox at the front door; code shared after signing.",
      manualUnavailableRanges: [],
      detail: r.detail,
      furnishing: "Fully furnished",
      roomAmenitiesText: "Closet\nHeating\nAC",
      photoDataUrls: [],
      videoDataUrl: null,
      utilitiesEstimate: "",
      prorateMethod: "auto",
    })),
    bathrooms: [
      {
        id: `${p.id}-bath-main`,
        name: "Hall bath",
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
    ],
    bundles: [],
    quickFacts: [],
  };
}

function propertyRow(p, managerUserId) {
  const rents = p.rooms.map((r) => r.rent);
  const min = Math.min(...rents);
  const max = Math.max(...rents);
  const fmt = (n) => `$${n.toLocaleString("en-US")}`;
  return {
    id: p.id,
    manager_user_id: managerUserId,
    status: "live",
    property_data: {
      id: p.id,
      title: p.name,
      tagline: p.tagline,
      address: p.address,
      zip: p.zip,
      neighborhood: p.neighborhood,
      beds: p.rooms.length,
      baths: p.rooms.length >= 4 ? 2 : 1,
      rentLabel: min === max ? `${fmt(min)} / mo` : `${fmt(min)}–${fmt(max)} / mo`,
      available: "Now",
      petFriendly: p.pets,
      buildingId: `${p.id}-bld`,
      buildingName: p.name,
      unitLabel: `${p.rooms.length} rooms`,
      mapLat: 47.6205,
      mapLng: -122.3212,
      managerUserId,
      adminPublishLive: true,
      listingSubmission: listingSubmission(p),
    },
    row_data: { id: p.id, status: "live", name: p.name, buildingName: p.name, address: p.address, testRunId: RUN_TAG },
    updated_at: NOW.toISOString(),
  };
}

/** Last day of the 12th month: a lease ending mid-month would bill a prorated last month. */
function leaseEndFor(leaseStartIso) {
  const [y, m] = leaseStartIso.split("-").map(Number);
  return isoDate(new Date(Date.UTC(y, m - 1 + 12, 0, 12)));
}

function applicationForm(p, signedAt) {
  const leaseStart = p.stage === "signed" ? isoDate(monthStart(p.signedBack)) : isoDate(daysFromNow(10));
  const leaseEnd = leaseEndFor(leaseStart);
  const ssnGroup = String(12 + (p.index % 88)).padStart(2, "0");
  return {
    fullLegalName: p.name,
    email: p.email,
    phone: `(206) 555-${String(1200 + p.index * 13).slice(-4)}`,
    dateOfBirth: `199${p.index % 10}-0${(p.index % 9) + 1}-14`,
    ssn: `000-${ssnGroup}-${String(1000 + p.index).padStart(4, "0")}`,
    driversLicense: `WA-DL-${4821000 + p.index}`,
    employer: "Northwest Health Partners",
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
    propertyId: p.prop,
    rentalType: "standard",
    leaseTerm: "12 months",
    leaseStart,
    leaseEnd,
    roomChoice1: p.roomChoice,
    roomChoice2: "",
    roomChoice3: "",
    shortTermCheckInTime: "",
    shortTermCheckOutTime: "",
    managerRentOverride: p.bucket === "approved" ? String(p.rent) : "",
    managerUtilitiesOverride: "",
    managerSecurityDepositOverride: "",
    managerMoveInFeeOverride: "",
    managerOtherCostLabel: "",
    managerOtherCostAmount: "",
    __signedRentLabel: `${usd(p.rent)} / month`,
    consentTruth: true,
    consentCredit: true,
    dateSigned: isoDate(signedAt ?? daysFromNow(-2)),
    digitalSignature: p.name,
    applicationFeePayChannel: "stripe",
    applicationFeeAcknowledged: true,
  };
}

function signedAtFor(p) {
  if (p.stage !== "signed") return null;
  // This month's signers signed on the 1st; earlier ones a few days before their lease started.
  return p.signedBack === 0 ? monthStart(0) : new Date(monthStart(p.signedBack).getTime() - 3 * 86400000);
}

function applicationRow(p, managerUserId) {
  const approved = p.bucket === "approved";
  const stage = approved ? "Approved - placed" : p.bucket === "rejected" ? "Rejected" : "Submitted";
  const detail = approved ? `Approved for ${p.roomDef.name}` : p.bucket === "rejected" ? p.rejectReason : `Submitted ${isoDate(daysFromNow(-1 - (p.index % 4)))}`;
  const orderedAt = daysFromNow(-2).toISOString();
  const backgroundCheck = {
    provider: "checkr",
    candidateId: `seed-cand-${p.axisId.toLowerCase()}`,
    reportId: `seed-report-${p.axisId.toLowerCase()}`,
    packageSlug: "test_pro_criminal",
    status: "complete",
    result: p.bucket === "rejected" ? "consider" : "clear",
    assessment: p.bucket === "rejected" ? "review" : "eligible",
    orderedAt,
    completedAt: daysFromNow(-1).toISOString(),
    simulated: true,
  };
  return {
    id: p.axisId,
    manager_user_id: managerUserId,
    resident_email: p.email,
    property_id: p.prop,
    assigned_property_id: approved ? p.prop : null,
    row_data: {
      id: p.axisId,
      axisId: p.axisId,
      bucket: p.bucket,
      stage,
      detail,
      email: p.email,
      name: p.name,
      property: p.propDef.name,
      application: applicationForm(p, signedAtFor(p)),
      backgroundCheck,
      backgroundCheckStatus: backgroundCheck.result === "clear" ? "passed" : "flagged",
      managerUserId,
      propertyId: p.prop,
      residentUserId: null,
      setupTokenConsumedAt: null,
      ...(approved ? { assignedPropertyId: p.prop, assignedRoomChoice: p.roomChoice, signedMonthlyRent: p.rent } : {}),
      testRunId: RUN_TAG,
    },
    updated_at: NOW.toISOString(),
  };
}

function leaseHtml(p, managerUserId) {
  try {
    return buildSeedLeaseHtml({
      application: applicationForm(p, signedAtFor(p)),
      propertyData: { id: p.prop, title: p.propDef.name, address: p.propDef.address, managerUserId, listingSubmission: listingSubmission(p.propDef) },
      monthlyRent: p.rent,
    });
  } catch (err) {
    console.warn(`  lease HTML fell back to a stub for ${p.name}: ${err.message}`);
    return `<section class="lease-doc"><h1>Residential Lease Agreement</h1><p><strong>Tenant:</strong> ${p.name}</p><p><strong>Premises:</strong> ${p.propDef.name} · ${p.roomDef.name}</p><p><strong>Monthly Rent:</strong> ${usd(p.rent)}</p></section>`;
  }
}

function leaseRow(p, managerUserId) {
  const signedAt = signedAtFor(p) ?? daysFromNow(-2);
  const sentIso = new Date(signedAt.getTime() - 86400000).toISOString();
  const resSignIso = signedAt.toISOString();
  const mgrSignIso = new Date(signedAt.getTime() + 86400000).toISOString();
  const base = {
    id: `lease_app_${p.axisId}`,
    residentName: p.name,
    residentEmail: p.email,
    unit: `${p.propDef.name} · ${p.roomDef.name}`,
    updated: "just now",
    pdfVersion: 2,
    versionNumber: 2,
    notes: "Created from approved application.",
    updatedAtIso: NOW.toISOString(),
    axisId: p.axisId,
    propertyId: p.prop,
    managerUserId,
    residentUserId: null,
    roomChoice: p.roomChoice,
    signedRentLabel: `${usd(p.rent)} / month`,
    application: applicationForm(p, signedAtFor(p)),
    generatedHtml: leaseHtml(p, managerUserId),
    generatedAtIso: daysFromNow(-4).toISOString(),
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
    testRunId: RUN_TAG,
  };
  const resSig = { name: p.name, signedAtIso: resSignIso, role: "resident" };
  let row = base;
  if (p.stage === "resident_sign") {
    row = { ...base, bucket: "resident", status: "Resident Signature Pending", stageLabel: "Resident Signature Pending", currentActorRole: "resident", sentToResidentAt: sentIso };
  } else if (p.stage === "manager_sign") {
    row = { ...base, bucket: "signed", status: "Manager Signature Pending", stageLabel: "Manager Signature Pending", currentActorRole: "manager", sentToResidentAt: sentIso, residentSignature: resSig, signatureName: p.name, signedAtIso: resSignIso, residentSignedAt: resSignIso };
  } else if (p.stage === "signed") {
    row = {
      ...base,
      bucket: "signed",
      status: "Fully Signed",
      stageLabel: "Signed",
      currentActorRole: "system",
      sentToResidentAt: sentIso,
      residentSignature: resSig,
      managerSignature: { name: MANAGER_NAME, signedAtIso: mgrSignIso, role: "manager" },
      signatureName: p.name,
      signedAtIso: resSignIso,
      residentSignedAt: resSignIso,
      managerSignedAt: mgrSignIso,
      fullySignedAt: mgrSignIso,
    };
  }
  return {
    id: row.id,
    manager_user_id: managerUserId,
    resident_user_id: null,
    resident_email: p.email,
    property_id: p.prop,
    status: row.bucket,
    row_data: row,
    updated_at: NOW.toISOString(),
  };
}

const usLabel = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * A signed resident's rent history: the first month's rent (the id the app itself uses), then one
 * monthly rent per month up to this one. All paid, except a first rent that is not yet due.
 */
function rentCharges(p, managerUserId) {
  const axisKey = chargeKeyPart(p.axisId);
  const emailKey = chargeKeyPart(p.email);
  const propKey = chargeKeyPart(p.prop);
  const profileId = `seed-rent-${emailKey}-${propKey}`;
  const amountLabel = `$${p.rent.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const out = [];
  for (let back = p.signedBack; back >= 0; back -= 1) {
    const start = monthStart(back);
    const rentMonth = monthKey(start);
    const first = back === p.signedBack;
    const dueDay = p.rentDueDay ?? 1;
    const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), dueDay, 12));
    const unpaid = back === 0 && Boolean(p.rentDueDay);
    const paidAt = new Date(due.getTime() + (p.index % 4) * 86400000).toISOString();
    out.push({
      id: first ? `hc_app_${axisKey}_first_month_rent` : `hc_rent_${emailKey}_${propKey}_${rentMonth}`,
      createdAt: start.toISOString(),
      applicationId: p.axisId,
      residentEmail: p.email,
      residentName: p.name,
      residentUserId: null,
      propertyId: p.prop,
      propertyLabel: p.propDef.name,
      managerUserId,
      kind: first ? "first_month_rent" : "rent",
      title: first ? "First month rent" : "Monthly rent",
      amountLabel,
      balanceLabel: unpaid ? amountLabel : "$0.00",
      status: unpaid ? "pending" : "paid",
      blocksLeaseUntilPaid: false,
      dueDateLabel: usLabel(due),
      ...(first ? {} : { rentMonth, recurringRentProfileId: profileId, dueDay }),
      ...(unpaid ? {} : { paidAt }),
    });
  }
  // The app bills one month ahead the moment it loads; seeding that month stops it posting an
  // "Rent — <month> · Payment update" notice per resident into the showcase inbox.
  const next = monthStart(-1);
  const nextMonth = monthKey(next);
  const nextDueDay = p.rentDueDay ?? 1;
  out.push({
    id: `hc_rent_${emailKey}_${propKey}_${nextMonth}`,
    createdAt: NOW.toISOString(),
    applicationId: p.axisId,
    residentEmail: p.email,
    residentName: p.name,
    residentUserId: null,
    propertyId: p.prop,
    propertyLabel: p.propDef.name,
    managerUserId,
    kind: "rent",
    title: "Monthly rent",
    amountLabel,
    balanceLabel: amountLabel,
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueDateLabel: usLabel(new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), nextDueDay, 12))),
    rentMonth: nextMonth,
    recurringRentProfileId: profileId,
    dueDay: nextDueDay,
  });
  return out;
}

function rentProfile(p, managerUserId) {
  const emailKey = chargeKeyPart(p.email);
  const propKey = chargeKeyPart(p.prop);
  const first = monthStart(p.signedBack);
  const leaseStartIso = isoDate(first);
  return {
    id: `seed-rent-${emailKey}-${propKey}`,
    residentEmail: p.email,
    residentName: p.name,
    residentUserId: null,
    propertyId: p.prop,
    propertyLabel: p.propDef.name,
    roomLabel: p.roomDef.name,
    managerUserId,
    monthlyRent: p.rent,
    dueDay: p.rentDueDay ?? 1,
    // The first month is its own charge, so the recurring schedule starts the month after.
    startMonth: monthKey(monthStart(p.signedBack - 1)),
    leaseEnd: leaseEndFor(leaseStartIso),
    active: true,
    updatedAt: NOW.toISOString(),
  };
}

/** The client's own manager inbox scope id (a different scope string is silently ignored). */
const INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const stamp = (d) => d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function inboxThreads(managerUserId, workspaceId) {
  const byName = (n) => PEOPLE.find((p) => p.name === n);
  const specs = [
    { who: "Priya Raman", subject: "Quiet hours question", theirs: "Hi Dana, is it okay if I have two friends over Saturday afternoon? We'll be out by 9.", reply: null, ago: 0.2, unread: true },
    { who: "Zoe Martin", subject: "Beacon Hill room — still available?", theirs: "Hi! I just applied for Room 3 at Beacon Hill House. Is the room still open for a move-in on the 1st?", reply: null, ago: 0.5, unread: true },
    { who: "Marcus Bell", subject: "Parking on 24th", theirs: "Quick question: is street parking on 24th Ave NW covered by the residential permit?", reply: "Yes, you're in the zone. I'll send the permit form today.", ago: 1.1, unread: false },
    { who: "Grace Kim", subject: "Move-in photos", theirs: "I added my move-in photos for Room 1. Let me know if you need any more angles.", reply: "Got them, thank you Grace. All set on my side.", ago: 1.6, unread: false },
    { who: "Noah Peterson", subject: "Application status", theirs: "Hi Dana, just checking in on my application for Fremont Flats. Anything else you need from me?", reply: null, ago: 2.2, unread: true },
    { who: "Sophie Laurent", subject: "Wi-Fi password", theirs: "Hey, the Wi-Fi dropped out this morning. Could you check the router when you can?", reply: "Rebooted it remotely. Let me know if it comes back.", ago: 2.9, unread: false },
    { who: "Chloe Bennett", subject: "Lease signing", theirs: "I got the lease link. Can I sign tonight and pick up the keys Thursday?", reply: "Thursday works. See you at 5.", ago: 3.4, unread: false },
    { who: "Elena Rossi", subject: "Rent receipt", theirs: "Could you send a receipt for October rent? My employer reimburses part of it.", reply: "Sent to your email just now.", ago: 4.1, unread: false },
  ];
  return specs.map((s, i) => {
    const p = byName(s.who);
    const sentAt = new Date(NOW.getTime() - s.ago * 86400000);
    const replyAt = new Date(sentAt.getTime() + 3600000);
    const id = `seed-inbox-showcase-${i + 1}`;
    const messages = [{ id: `${id}-m1`, from: p.name, body: s.theirs, at: stamp(sentAt), outbound: false }];
    if (s.reply) messages.push({ id: `${id}-m2`, from: "Property Manager", body: s.reply, at: stamp(replyAt), outbound: true });
    const conversationKey = `mail:${p.email.toLowerCase()}`;
    return {
      id,
      scope: INBOX_SCOPE,
      owner_user_id: managerUserId,
      participant_email: p.email.toLowerCase(),
      thread_type: "portal_message",
      workspace_id: workspaceId,
      conversation_key: conversationKey,
      row_data: {
        id,
        scope: INBOX_SCOPE,
        folder: "inbox",
        from: p.name,
        email: p.email,
        subject: s.subject,
        preview: (s.reply ?? s.theirs).slice(0, 90),
        body: s.theirs,
        time: stamp(s.reply ? replyAt : sentAt),
        unread: s.unread,
        messages,
        workspaceId,
        conversationKey,
        testRunId: RUN_TAG,
      },
      updated_at: NOW.toISOString(),
    };
  });
}

// ── Calendar singletons (tour availability, tours) ──────────────────────────

const startOfWeekMonday = () => {
  const x = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12, 0, 0, 0);
  const wd = x.getDay();
  x.setDate(x.getDate() + (wd === 0 ? -6 : 1 - wd));
  return x;
};
const slotIso = (dateStr, slot) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const minutes = slot * 30;
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).toISOString();
};
function availabilityKeys() {
  const keys = [];
  const monday = startOfWeekMonday();
  for (let week = 0; week < 2; week += 1) {
    for (let day = 0; day < 6; day += 1) {
      const d = new Date(monday);
      d.setDate(d.getDate() + week * 7 + day);
      for (let slot = 18; slot < 34; slot += 1) keys.push(`${isoDate(d)}:${slot}`);
    }
  }
  return keys;
}

async function mergeSingleton(id, recordType, ownerUserId, items) {
  const { data: existing, error } = await supabase.from("portal_schedule_records").select("id, row_data, manager_user_id").eq("id", id).maybeSingle();
  if (error) throw new Error(`select ${id}: ${error.message}`);
  const current = Array.isArray(existing?.row_data?.payload) ? existing.row_data.payload : [];
  // Idempotent: drop this manager's earlier showcase items, keep everybody else's.
  const kept = current.filter((item) => item?.managerUserId !== ownerUserId);
  await must(
    supabase.from("portal_schedule_records").upsert(
      {
        id,
        manager_user_id: existing?.manager_user_id ?? ownerUserId,
        record_type: recordType,
        row_data: { id, recordType, managerUserId: existing?.row_data?.managerUserId ?? ownerUserId, payload: [...kept, ...items] },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    `portal_schedule_records(${id})`,
  );
}

async function seedTours(managerUserId) {
  const keys = availabilityKeys();
  const registryId = "axis_property_mgr_registry_v1";
  const { data: reg } = await supabase.from("portal_schedule_records").select("row_data").eq("id", registryId).maybeSingle();
  const registry = reg?.row_data?.payload && typeof reg.row_data.payload === "object" && !Array.isArray(reg.row_data.payload) ? { ...reg.row_data.payload } : {};
  for (const p of PROPERTIES) {
    const id = `axis_mgr_avail_slots_v2_${managerUserId}_prop_${p.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    await must(
      supabase.from("portal_schedule_records").upsert(
        { id, manager_user_id: managerUserId, property_id: p.id, record_type: "manager_property_availability", row_data: { id, recordType: "manager_property_availability", managerUserId, propertyId: p.id, payload: keys }, updated_at: NOW.toISOString() },
        { onConflict: "id" },
      ),
      `availability(${p.id})`,
    );
    const hosts = Array.isArray(registry[p.id]) ? registry[p.id] : [];
    if (!hosts.some((h) => h.userId === managerUserId)) hosts.push({ userId: managerUserId, label: MANAGER_NAME, propertyId: p.id });
    registry[p.id] = hosts;
  }
  await must(
    supabase.from("portal_schedule_records").upsert(
      { id: registryId, manager_user_id: null, record_type: registryId, row_data: { id: registryId, recordType: registryId, payload: registry }, updated_at: NOW.toISOString() },
      { onConflict: "id" },
    ),
    registryId,
  );

  const planned = [];
  const inquiries = [];
  const eventRows = [];
  TOURS.forEach((t, i) => {
    const prop = PROP_BY_ID.get(t.prop);
    const ds = isoDate(daysFromNow(t.daysOut));
    const start = slotIso(ds, t.slot);
    const end = slotIso(ds, t.slot + 2);
    if (t.status === "confirmed") {
      planned.push({ id: `seed-showcase-planned-${i}`, title: `Tour · ${t.name}`, start, end, kind: "tour", managerUserId, propertyId: prop.id, propertyTitle: prop.name, attendeeName: t.name, attendeeEmail: t.email, attendeePhone: t.phone, slotKey: `${ds}:${t.slot}` });
    } else {
      const inquiry = {
        id: `seed-showcase-pending-${i}`,
        name: t.name,
        email: t.email,
        phone: t.phone,
        notes: "Looking for a furnished room with natural light.",
        kind: "tour",
        status: "pending",
        managerUserId,
        propertyId: prop.id,
        propertyTitle: prop.name,
        proposedStart: start,
        proposedEnd: end,
        createdAt: NOW.toISOString(),
        tourGroupId: `seed-showcase-grp-${i}`,
        requestedWindows: [{ start, end, slotKey: `${ds}:${t.slot}`, adminUserId: managerUserId }],
      };
      inquiries.push(inquiry);
      // The portal reads a manager's pending requests from one row per window (property-scoped, so
      // the active workspace can narrow it); the shared singleton alone is dropped by that scoping.
      const eventId = `partner_inquiry_request_${inquiry.id}_0`;
      eventRows.push({
        id: eventId,
        manager_user_id: managerUserId,
        property_id: prop.id,
        record_type: "partner_inquiry_request",
        starts_at: start,
        ends_at: end,
        row_data: { id: eventId, recordType: "partner_inquiry_request", managerUserId, propertyId: prop.id, payload: inquiry },
        updated_at: NOW.toISOString(),
      });
    }
  });
  if (eventRows.length) await must(supabase.from("portal_schedule_records").upsert(eventRows, { onConflict: "id" }), "partner_inquiry_request rows");
  await mergeSingleton("axis_admin_planned_events_v1", "axis_admin_planned_events_v1", managerUserId, planned);
  await mergeSingleton("axis_admin_partner_inquiries_v1", "axis_admin_partner_inquiries_v1", managerUserId, inquiries);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function mergeAutomationSettings(managerUserId) {
  const { data: existing } = await supabase.from("manager_automation_settings").select("row_data").eq("manager_user_id", managerUserId).maybeSingle();
  const rowData = existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data) ? { ...existing.row_data } : {};
  rowData.landlordProfile = { ...(rowData.landlordProfile ?? {}), landlordLegalName: BUSINESS_NAME };
  rowData.googleServicesOnboarding = { dismissedAt: NOW.toISOString() };
  await must(
    supabase.from("manager_automation_settings").upsert({ manager_user_id: managerUserId, row_data: rowData, updated_at: NOW.toISOString() }, { onConflict: "manager_user_id" }),
    "manager_automation_settings",
  );
}

async function main() {
  console.log(`Seeding the App Store showcase manager ${MANAGER_EMAIL} on ${new URL(url).hostname} ...`);
  const userId = await ensureManagerUser();

  // Business id: keep the profile's own when it has one.
  const { data: profile } = await supabase.from("profiles").select("manager_id").eq("id", userId).maybeSingle();
  const managerId = profile?.manager_id?.trim() || "MGR-NGTSHOW1";
  const { data: squatters } = await supabase.from("profiles").select("id").eq("manager_id", managerId).neq("id", userId);
  for (const s of squatters ?? []) await must(supabase.from("profiles").update({ manager_id: null }).eq("id", s.id), "release manager_id");
  await must(
    supabase.from("profiles").upsert(
      { id: userId, email: MANAGER_EMAIL, role: "manager", manager_id: managerId, full_name: MANAGER_NAME, phone: MANAGER_PHONE, sms_from_number: WORK_NUMBER, updated_at: NOW.toISOString() },
      { onConflict: "id" },
    ),
    "profiles",
  );
  await must(supabase.from("profile_roles").upsert({ user_id: userId, role: "manager" }, { onConflict: "user_id,role" }), "profile_roles");
  await must(supabase.from("profile_roles").delete().eq("user_id", userId).neq("role", "manager"), "profile_roles(strip)");

  // Business plan (portal waiver, no Stripe): the 20-listing cap covers six properties.
  const { data: purchase } = await supabase.from("manager_purchases").select("id").eq("user_id", userId).maybeSingle();
  const purchasePatch = { tier: "business", billing: "portal", promo_code: "FREE100", paid_at: NOW.toISOString(), email: MANAGER_EMAIL, user_id: userId };
  if (purchase?.id) await must(supabase.from("manager_purchases").update(purchasePatch).eq("id", purchase.id), "manager_purchases(update)");
  else await must(supabase.from("manager_purchases").upsert({ ...purchasePatch, manager_id: managerId, stripe_checkout_session_id: "seed_app_store_showcase" }, { onConflict: "manager_id" }), "manager_purchases");
  await mergeAutomationSettings(userId);

  // Reset ONLY this manager's rows so a re-run lands on identical data.
  for (const table of [
    "portal_household_charge_records",
    "portal_recurring_rent_profile_records",
    "portal_lease_pipeline_records",
    "portal_work_order_records",
    "portal_service_request_records",
    "manager_application_records",
    "manager_promotion_records",
    "manager_vendor_records",
    "manager_property_records",
  ]) {
    await must(supabase.from(table).delete().eq("manager_user_id", userId), `reset ${table}`);
  }
  await must(supabase.from("portal_inbox_thread_records").delete().eq("owner_user_id", userId), "reset inbox");
  // Only this manager's own availability rows: the shared singletons hold other managers' items.
  await must(supabase.from("portal_schedule_records").delete().eq("manager_user_id", userId).in("record_type", ["manager_property_availability", "partner_inquiry_request"]), "reset schedule");

  // Workspace named for the business; its work number on file (no "Phone number not set up").
  const workspaceId = await must(supabase.rpc("ensure_default_portal_workspace", { p_owner: userId }), "ensure workspace");
  await must(supabase.from("portal_workspaces").update({ name: WORKSPACE_NAME }).eq("id", workspaceId), "workspace name");
  const numberRow = {
    manager_user_id: userId,
    workspace_id: workspaceId,
    phone_number: WORK_NUMBER,
    provision_state: "active",
    registration_state: "approved",
    attachment_state: "attached",
    number_registration_state: "registered",
    provisioned_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const numbers = await must(supabase.from("manager_sms_numbers").upsert(numberRow, { onConflict: "workspace_id" }).select("id"), "manager_sms_numbers");
  const numberId = numbers?.[0]?.id;
  if (numberId) {
    await must(supabase.from("workspace_work_numbers").upsert({ workspace_id: workspaceId, number_id: numberId, is_primary: true }, { onConflict: "workspace_id,number_id" }), "workspace_work_numbers");
  }

  await must(supabase.from("manager_property_records").upsert(PROPERTIES.map((p) => propertyRow(p, userId)), { onConflict: "id" }), "manager_property_records");
  await must(supabase.from("manager_application_records").upsert(PEOPLE.map((p) => applicationRow(p, userId)), { onConflict: "id" }), "manager_application_records");

  const approved = PEOPLE.filter((p) => p.bucket === "approved");
  await must(supabase.from("portal_lease_pipeline_records").upsert(approved.map((p) => leaseRow(p, userId)), { onConflict: "id" }), "portal_lease_pipeline_records");

  const signed = approved.filter((p) => p.stage === "signed");
  const charges = signed.flatMap((p) => rentCharges(p, userId));
  await must(supabase.from("portal_household_charge_records").upsert(charges.map(householdChargeDbRow), { onConflict: "id" }), "portal_household_charge_records");
  await must(supabase.from("portal_recurring_rent_profile_records").upsert(signed.map((p) => rentProfileDbRow(rentProfile(p, userId))), { onConflict: "id" }), "portal_recurring_rent_profile_records");

  // Two open services so the dashboard has something real to count.
  const serviceHolders = signed.slice(0, 2).map((p) => ({ axisId: p.axisId, email: p.email, name: p.name, prop: { name: p.propDef.name, address: p.propDef.address, ownerUserId: userId }, propId: p.prop, room: p.roomDef, roomChoice: p.roomChoice, testRunId: RUN_TAG }));
  const workOrders = serviceHolders.slice(0, 1).flatMap((p) => buildSeedWorkOrdersForPerson(p, { now: NOW }).slice(0, 1)).map(workOrderDbRow);
  const serviceRequests = serviceHolders.slice(1).flatMap((p) => buildSeedServiceRequestsForPerson(p, { now: NOW }).slice(1)).map(serviceRequestDbRow);
  await must(supabase.from("portal_work_order_records").upsert(workOrders, { onConflict: "id" }), "portal_work_order_records");
  await must(supabase.from("portal_service_request_records").upsert(serviceRequests, { onConflict: "id" }), "portal_service_request_records");

  await must(supabase.from("portal_inbox_thread_records").upsert(inboxThreads(userId, workspaceId), { onConflict: "id" }), "portal_inbox_thread_records");
  await seedTours(userId);

  // The figures the dashboard will compute, checked here so a bad edit fails the seed.
  const rooms = PROPERTIES.reduce((n, p) => n + p.rooms.length, 0);
  const occupancy = signed.length / rooms;
  const thisMonth = monthKey(NOW);
  const dueNow = charges.filter((c) => monthKey(new Date(c.dueDateLabel)) === thisMonth);
  const due = dueNow.reduce((s, c) => s + Number(c.amountLabel.replace(/[$,]/g, "")), 0);
  const collected = dueNow.filter((c) => c.status === "paid").reduce((s, c) => s + Number(c.amountLabel.replace(/[$,]/g, "")), 0);
  const pct = collected / due;
  if (occupancy < 0.85 || occupancy > 0.9) throw new Error(`occupancy ${Math.round(occupancy * 100)}% is outside 85-90%`);
  if (pct < 0.95 || pct > 0.97) throw new Error(`rent collected ${Math.round(pct * 100)}% is outside ~96%`);

  if (mintedPassword) {
    const prefix = existsSync(ENV_LOCAL) && !readFileSync(ENV_LOCAL, "utf8").endsWith("\n") ? "\n" : "";
    appendFileSync(ENV_LOCAL, `${prefix}SHOT_EMAIL=${MANAGER_EMAIL}\nSHOT_PASSWORD=${MANAGER_PASSWORD}\n`);
  }

  console.log(
    [
      "",
      `  properties ${PROPERTIES.length} · rooms ${rooms} · occupied ${signed.length} (${Math.round(occupancy * 100)}%)`,
      `  rent collected $${collected.toLocaleString("en-US")} of $${due.toLocaleString("en-US")} due (${Math.round(pct * 100)}%) · overdue 0`,
      `  applicants ${PEOPLE.filter((p) => p.bucket === "pending").length} pending · leases ${approved.length} (signed ${signed.length}, manager review 1, resident signature 1, manager signature 1)`,
      `  tours ${TOURS.length} · inbox threads ${inboxThreads(userId, workspaceId).length}`,
      "",
      mintedPassword ? "  Wrote SHOT_EMAIL / SHOT_PASSWORD to .env.local (gitignored)." : "  Using SHOT_EMAIL / SHOT_PASSWORD already in .env.local.",
      `  Shoot as this manager:  SHOT_EMAIL=${MANAGER_EMAIL} SHOT_PASSWORD=… npm run app-store:shots -- --base http://localhost:3000`,
      "  (the generator reads SHOT_EMAIL / SHOT_PASSWORD from the environment; export them from .env.local).",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(`\nApp Store seed failed: ${error.message}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * Showcase seed: the home page's sample story ("Seattle Homes", Manager,
 * Resident, Pacific Plumbing) as REAL rows on the dev/test Supabase
 * project, so a capture script can screenshot every portal page with data.
 *
 *   npm run seed:showcase
 *   node --env-file=.env.local scripts/seed-showcase.mjs
 *
 * Mirrors `src/components/marketing/site/product-mock/{world,fixtures}.ts`.
 *
 * SAFETY
 *  - Refuses unless NEXT_PUBLIC_SUPABASE_URL is the dedicated dev/test project
 *    (`assertTestProjectUrl`) and is not the production project. Never reads
 *    `.env.production*`.
 *  - Touches ONLY accounts it created (auth user_metadata.showcase === true).
 *    If an email already exists WITHOUT that mark the script aborts instead of
 *    resetting a password.
 *  - Never touches the canonical test accounts or the locked live listings.
 *  - Idempotent: rows owned by the showcase manager are deleted and recreated
 *    from scratch each run (every row is scoped by the showcase manager/vendor
 *    id and prefixed `showcase-` / `AXIS-SHOW`), so re-running never duplicates.
 *
 * `npm run test:seed` prunes every non-canonical auth account on the test
 * project; re-run `npm run seed:showcase` after a full reseed.
 *
 * Logins (all on the dev/test project only):
 *   showcase.manager@test.proplane.local   ShowcaseManager123!
 *   showcase.resident@test.proplane.local  ShowcaseResident123!
 *   showcase.vendor@test.proplane.local    ShowcaseVendor123!
 */
import { createClient } from "@supabase/supabase-js";
import {
  TEST_SUPABASE_PROJECT_REF,
  assertTestProjectUrl,
} from "../tests/helpers/canonical-test-accounts.mjs";
import { isProductionSupabaseProjectUrl } from "../tests/helpers/canonical-production-accounts.mjs";
import { buildSeedLeaseHtml } from "../tests/helpers/build-seed-lease-html.mjs";
import {
  chargeKeyPart,
  householdChargeDbRow,
  rentProfileDbRow,
} from "../tests/helpers/build-seed-catalog-charges.mjs";

/* ───────────────────────────── Guards ───────────────────────────── */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (use --env-file=.env.local).");
  process.exit(1);
}
if (isProductionSupabaseProjectUrl(url)) {
  console.error("Refusing to seed: that is the PRODUCTION Supabase project.");
  process.exit(1);
}
try {
  assertTestProjectUrl(url);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const ref = new URL(url).hostname.split(".")[0];
if (ref !== TEST_SUPABASE_PROJECT_REF) {
  console.error(`Refusing to seed: expected ${TEST_SUPABASE_PROJECT_REF}, got ${ref}.`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

/* ───────────────────────────── Constants ───────────────────────────── */

const NOW = new Date();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY);
const isoDate = (d) => d.toISOString().slice(0, 10);
const iso = (d) => d.toISOString();
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdWhole = (n) => `$${Number(n).toLocaleString("en-US")}`;

const MANAGER_EMAIL = "showcase.manager@test.proplane.local";
const MANAGER_PASSWORD = "ShowcaseManager123!";
const MANAGER_NAME = "Manager";
const WORKSPACE_NAME = "Seattle Homes";
const RESIDENT_EMAIL = "showcase.resident@test.proplane.local";
const RESIDENT_PASSWORD = "ShowcaseResident123!";
const VENDOR_EMAIL = "showcase.vendor@test.proplane.local";
const VENDOR_PASSWORD = "ShowcaseVendor123!";
const SIDE_PASSWORD = "ShowcaseSide123!"; // non-login residents, never shown

// Gentle on the shared dev DB: ~200ms between requests, and abort (never keep retrying) after
// 3 timeouts/overload errors in a row.
const PACE_MS = 200;
const BATCH = 50;
let consecutiveTimeouts = 0;
let lastStep = "(start)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOverload = (msg) => /timeout|canceling statement|ERR_HTTP2|fetch failed|upstream|503|502|504|ECONN/i.test(String(msg));

async function must(promise, label) {
  lastStep = label;
  const { data, error } = await promise;
  if (error) {
    if (isOverload(error.message ?? error)) {
      consecutiveTimeouts++;
      if (consecutiveTimeouts >= 3) {
        console.error(`ABORT: the database returned ${consecutiveTimeouts} timeouts in a row. Stopped at: ${label}. Re-run later; the seed is idempotent.`);
        process.exit(2);
      }
    } else {
      consecutiveTimeouts = 0;
    }
    throw new Error(`${label}: ${error.message}`);
  }
  consecutiveTimeouts = 0;
  await sleep(PACE_MS);
  return data;
}

/** Write rows in batches of <= BATCH, sequentially. mode: "insert" | "upsert". */
async function put(table, mode, rows, onConflict, label = table) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const q = supabase.from(table);
    await must(mode === "insert" ? q.insert(slice) : q.upsert(slice, onConflict ? { onConflict } : undefined), `${label}[${i}..${i + slice.length}]`);
  }
}

function money(n) {
  return usd(n);
}

/* ───────────────────────────── Accounts ───────────────────────────── */

async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

/**
 * Create (or re-claim) a showcase auth user + profile + role. Refuses to touch
 * an existing user that this script did not create.
 */
async function ensureShowcaseUser(email, password, role, { managerId, fullName }) {
  const lower = email.toLowerCase();
  const existing = await findUserByEmail(lower);
  let userId;
  if (existing) {
    if (existing.user_metadata?.showcase !== true) {
      throw new Error(`${lower} already exists and was not created by seed-showcase. Refusing to modify it.`);
    }
    userId = existing.id;
    await must(
      supabase.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        user_metadata: { ...existing.user_metadata, role, showcase: true, axis_id: managerId },
      }),
      `updateUser ${lower}`,
    );
  } else {
    const created = await must(
      supabase.auth.admin.createUser({
        email: lower,
        password,
        email_confirm: true,
        user_metadata: { role, showcase: true, axis_id: managerId },
      }),
      `createUser ${lower}`,
    );
    userId = created.user.id;
  }
  // profiles.manager_id is UNIQUE: only reclaim it from other SHOWCASE profiles.
  const squatters = await must(
    supabase.from("profiles").select("id,email").eq("manager_id", managerId).neq("id", userId),
    `profiles(squat ${managerId})`,
  );
  for (const s of squatters ?? []) {
    if (!/\.showcase|^showcase\./.test(String(s.email ?? "")) && !String(s.email ?? "").endsWith("@example.com")) {
      throw new Error(`${managerId} is held by ${s.email}; refusing to reclaim from a non-showcase profile.`);
    }
    await must(supabase.from("profiles").update({ manager_id: null }).eq("id", s.id), `profiles(release ${managerId})`);
  }
  await must(
    supabase.from("profiles").upsert(
      {
        id: userId,
        email: lower,
        role,
        manager_id: managerId,
        full_name: fullName,
        application_approved: role === "resident",
      },
      { onConflict: "id" },
    ),
    `profiles(${lower})`,
  );
  await must(supabase.from("profile_roles").upsert({ user_id: userId, role }, { onConflict: "user_id,role" }), `profile_roles(${lower})`);
  await must(
    supabase.from("profile_roles").delete().eq("user_id", userId).neq("role", role),
    `profile_roles(strip ${lower})`,
  );
  return userId;
}

/* ───────────────────────────── The world ───────────────────────────── */

const room = (n, name, floor, rent, detail, capacity = 1) => ({ id: `room-${n}`, name, floor, rent, detail, capacity });

const PROPERTIES = [
  {
    id: "showcase-willow",
    name: "Willow Court",
    address: "61 Willow Court, Seattle, WA 98103",
    zip: "98103",
    neighborhood: "Wallingford",
    tagline: "Shared house near Wallingford's shops.",
    overview: "A three-room shared house in Wallingford with a full kitchen, a backyard and a short walk to the Burke-Gilman Trail.",
    deposit: 1080,
    petFriendly: true,
    rooms: [
      room(1, "Room 1", "1st floor", 1120, "Garden-level room with a queen bed and desk."),
      room(2, "Room 2", "2nd floor", 1100, "Front-facing room with a full bed."),
      room(3, "Room 3", "2nd floor", 1080, "Sunny corner room with a closet and desk."),
    ],
  },
  {
    id: "showcase-alder",
    name: "Alder House",
    address: "210 Alder St, Seattle, WA 98122",
    zip: "98122",
    neighborhood: "Central District",
    tagline: "Bright shared house near the light rail.",
    overview: "A three-room shared house in the Central District with a renovated kitchen and in-unit laundry.",
    deposit: 1650,
    petFriendly: false,
    rooms: [
      room(1, "Room 1", "1st floor", 1650, "Spacious room with a queen bed."),
      room(2, "Room 2", "2nd floor", 1650, "Quiet room with a south-facing window."),
      room(3, "Room 3", "2nd floor", 1650, "Room with a built-in desk."),
    ],
  },
  {
    id: "showcase-maple",
    name: "Maple Duplex",
    address: "1412 Maple Ct, Seattle, WA 98107",
    zip: "98107",
    neighborhood: "Ballard",
    tagline: "Two-unit duplex steps from Ballard Ave.",
    overview: "A duplex in Ballard with two self-contained units, each with a private entrance.",
    deposit: 1850,
    petFriendly: true,
    rooms: [
      room(1, "Unit A", "Main floor", 1850, "Main-floor unit with a private entrance."),
      room(2, "Unit B", "Upper floor", 1850, "Upper-floor unit with a balcony."),
    ],
  },
  {
    id: "showcase-fremont",
    name: "Fremont Studio",
    address: "3301 Fremont Ave N, Seattle, WA 98103",
    zip: "98103",
    neighborhood: "Fremont",
    tagline: "Furnished studio near the canal.",
    overview: "A furnished studio in Fremont, a block from the canal path and the 40 bus.",
    deposit: 1400,
    petFriendly: false,
    rooms: [room(1, "Studio", "2nd floor", 1400, "Furnished studio with a kitchenette.", 2)],
  },
];
const propById = new Map(PROPERTIES.map((p) => [p.id, p]));
const roomOf = (propId, roomName) => propById.get(propId).rooms.find((r) => r.name === roomName);

function buildListingSubmission(p, managerUserId) {
  const roomIds = p.rooms.map((r) => r.id);
  return {
    v: 1,
    buildingName: p.name,
    address: p.address,
    zip: p.zip,
    neighborhood: p.neighborhood,
    listingPlaceCategoryId: "private_room",
    tagline: p.tagline,
    petFriendly: p.petFriendly,
    houseOverview: p.overview,
    houseRulesText: "Quiet hours 10pm-8am. No smoking anywhere on the premises. Clean shared spaces after use.",
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
        detail: "Full kitchen shared by all residents.",
        amenitiesText: "Refrigerator\nDishwasher\nGas range",
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
      occupancyCapacity: r.capacity,
      availability: "Now",
      moveInAvailableDate: isoDate(NOW),
      moveInInstructions: "Lockbox at the front door; code shared after signing.",
      manualUnavailableRanges: [],
      detail: r.detail,
      furnishing: "Fully furnished",
      roomAmenitiesText: "Closet\nHeating\nWi-Fi",
      photoDataUrls: [],
      videoDataUrl: null,
      utilitiesEstimate: "",
      prorateMethod: "auto",
    })),
    bathrooms: [
      {
        id: `${p.id}-bath-main`,
        name: "Main bath",
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
    managerUserId,
  };
}

/**
 * Applicants. `bucket` is the application bucket; `lease` the lease stage the
 * home page draws for them (null = no lease). Emails are the fixtures' own,
 * except Jordan whose login is the showcase resident account.
 */
/** Days from today to the 1st of the month `n` months back (leases start on the 1st, so nothing prorates). */
const firstOfMonth = (n) => {
  const t = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  return Math.round((new Date(NOW.getFullYear(), NOW.getMonth() - n, 1).getTime() - t.getTime()) / DAY);
};

const PEOPLE = [
  { key: "jordan", name: "Resident", email: RESIDENT_EMAIL, prop: "showcase-willow", room: "Room 3", bucket: "approved", lease: "signed", income: 62000, current: true, since: firstOfMonth(1), login: true },
  { key: "priya", name: "Priya Nair", email: "priya.nair@example.com", prop: "showcase-willow", room: "Room 1", bucket: "approved", lease: "signed", income: 78000, current: true, since: firstOfMonth(3) },
  { key: "tomas", name: "Tomas Alvarez", email: "tomas.alvarez@example.com", prop: "showcase-willow", room: "Room 2", bucket: "approved", lease: "signed", income: 71000, current: true, since: firstOfMonth(2) },
  { key: "liam", name: "Liam Foster", email: "liam.foster@example.com", prop: "showcase-alder", room: "Room 1", bucket: "approved", lease: "signed", income: 88000, current: true, since: firstOfMonth(2) },
  { key: "maya", name: "Maya Chen", email: "maya.chen@example.com", prop: "showcase-maple", room: "Unit B", bucket: "approved", lease: "signed", income: 96000, current: true, since: firstOfMonth(1) },
  { key: "dana", name: "Dana Reyes", email: "dana.reyes@example.com", prop: "showcase-maple", room: "Unit A", bucket: "approved", lease: "manager_sign", income: 90000, current: true, since: firstOfMonth(2) },
  { key: "luis", name: "Luis Ortega", email: "luis.ortega@example.com", prop: "showcase-fremont", room: "Studio", bucket: "approved", lease: "manager_sign", income: 84000, current: true, since: firstOfMonth(2) },
  { key: "jamie", name: "Jamie P.", email: "jamie.p@example.com", prop: "showcase-fremont", room: "Studio", bucket: "approved", lease: "resident_sign", income: 74000 },
  { key: "morgan", name: "Morgan Ito", email: "morgan.ito@example.com", prop: "showcase-alder", room: "Room 2", bucket: "approved", lease: "manager", income: 69000 },
  { key: "sam", name: "Sam Chen", email: "sam.chen@example.com", prop: "showcase-maple", room: "Unit B", bucket: "approved", lease: "signed", income: 66000, past: true, since: -400, end: -45 },
  // Open applications
  { key: "sample", name: "Sample Applicant", email: "sample.applicant@example.com", prop: "showcase-maple", room: "Unit A", bucket: "pending", screening: "flagged", stage: "Screening", submittedDays: -3 },
  { key: "ethan", name: "Ethan Wright", email: "ethan.wright@example.com", prop: "showcase-fremont", room: "Studio", bucket: "pending", screening: "flagged", stage: "Screening", submittedDays: -4, shared: true },
  { key: "mason", name: "Mason Clark", email: "mason.clark@example.com", prop: "showcase-alder", room: "Room 3", bucket: "pending", screening: "passed", stage: "Screening", submittedDays: -5 },
  { key: "olivia", name: "Olivia Brooks", email: "olivia.brooks@example.com", prop: "showcase-maple", room: "Unit B", bucket: "pending", stage: "Documents complete", submittedDays: -6 },
  { key: "sam-o", name: "Sam Ostrowski", email: "sam.o@example.com", prop: "showcase-maple", room: "Unit B", bucket: "incomplete", stage: "Documents pending", submittedDays: -2 },
  { key: "ava", name: "Ava Sullivan", email: "ava.sullivan@example.com", prop: "showcase-alder", room: "Room 2", bucket: "incomplete", stage: "Photo ID pending", submittedDays: -2 },
  { key: "alexis", name: "Alexis Cole", email: "alexis.cole@example.com", prop: "showcase-fremont", room: "Studio", bucket: "rejected", stage: "Rejected", submittedDays: -32 },
];
for (const p of PEOPLE) {
  p.axisId = `AXIS-SHOW${p.key.replace(/[^a-z]/g, "").toUpperCase().slice(0, 8)}`;
  p.propData = propById.get(p.prop);
  p.roomData = roomOf(p.prop, p.room);
  p.rent = p.roomData.rent;
  p.roomChoice = `${p.prop}::${p.roomData.id}`;
}
const person = (key) => PEOPLE.find((p) => p.key === key);

function buildApplication(p) {
  const idx = PEOPLE.indexOf(p);
  const [first, ...rest] = p.name.split(" ");
  const last = rest.join(" ") || "Applicant";
  return {
    fullLegalName: p.name,
    email: p.email,
    phone: `(206) 555-01${String(40 + idx).padStart(2, "0")}`,
    dateOfBirth: `199${idx % 10}-0${(idx % 9) + 1}-14`,
    ssn: `000-${String(12 + idx).padStart(2, "0")}-${String(1000 + idx)}`,
    driversLicense: `WA-DL-${4821000 + idx}`,
    employer: "Northwest Tech Co.",
    jobTitle: "Analyst",
    employerAddress: "500 Union St, Seattle, WA",
    employmentStart: "2022-03-01",
    supervisorName: "Dana Wells",
    supervisorPhone: "(206) 555-0133",
    monthlyIncome: String(Math.round((p.income ?? 72000) / 12)),
    annualIncome: String(p.income ?? 72000),
    notEmployed: false,
    otherIncome: "",
    occupancyCount: p.shared ? "2" : "1",
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
    ref1Name: "Priya Shah",
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
    leaseStart: isoDate(daysFromNow(p.since != null ? p.since : 10)),
    leaseEnd: isoDate(daysFromNow(p.end != null ? p.end : (p.since != null ? p.since : 10) + 365)),
    roomChoice1: p.roomChoice,
    roomChoice2: "",
    roomChoice3: "",
    shortTermCheckInTime: "",
    shortTermCheckOutTime: "",
    managerRentOverride: String(p.rent),
    managerUtilitiesOverride: "0",
    managerSecurityDepositOverride: String(p.propData.deposit),
    managerMoveInFeeOverride: "250",
    managerOtherCostLabel: "",
    managerOtherCostAmount: "",
    __signedRentLabel: `${usd(p.rent)} / month`,
    consentTruth: true,
    consentCredit: true,
    dateSigned: isoDate(daysFromNow((p.submittedDays ?? -10))),
    digitalSignature: p.name,
    applicationFeePayChannel: "stripe",
    applicationFeeAcknowledged: true,
    __first: first,
    __last: last,
  };
}

function cleanApplication(p) {
  const a = buildApplication(p);
  delete a.__first;
  delete a.__last;
  return a;
}


/* ───────────────────────────── Lease + charge builders ───────────────────────────── */

function leaseHtmlStub(p) {
  return (
    `<section class="lease-doc"><h1>Residential Lease Agreement</h1>` +
    `<p><strong>Tenant:</strong> ${p.name}</p><p><strong>Premises:</strong> ${p.propData.name} · ${p.roomData.name}</p>` +
    `<p><strong>Monthly Rent:</strong> ${usd(p.rent)}</p><p><strong>Term:</strong> 12 months</p></section>`
  );
}

function buildLeaseHtml(p, managerUserId) {
  try {
    return buildSeedLeaseHtml({
      application: cleanApplication(p),
      propertyData: {
        id: p.prop,
        title: p.propData.name,
        address: p.propData.address,
        managerUserId,
        listingSubmission: buildListingSubmission(p.propData, managerUserId),
      },
      monthlyRent: p.rent,
    });
  } catch (err) {
    console.warn(`  lease html fallback for ${p.key}: ${err.message}`);
    return leaseHtmlStub(p);
  }
}

/** Lease stages the home page draws: draft, manager (review), resident, manager_sign, signed. */
function buildLeaseRow(p, managerUserId, leaseHtml) {
  const startDay = p.lease === "signed" ? (p.since ?? 0) : 0;
  const gen = daysFromNow(startDay - 4);
  const sent = daysFromNow(startDay - 3);
  const resSign = daysFromNow(startDay - 2);
  const mgrSign = daysFromNow(startDay - 1);
  const base = {
    id: `lease_app_${p.axisId}`,
    residentName: p.name,
    residentEmail: p.email,
    unit: `${p.propData.name} · ${p.roomData.name}`,
    updated: "just now",
    pdfVersion: 1,
    versionNumber: 1,
    notes: "Created from approved application.",
    updatedAtIso: iso(NOW),
    axisId: p.axisId,
    propertyId: p.prop,
    managerUserId,
    residentUserId: p.userId ?? null,
    roomChoice: p.roomChoice,
    signedRentLabel: `${usd(p.rent)} / month`,
    application: cleanApplication(p),
    generatedHtml: p.lease === "draft" ? null : leaseHtml,
    generatedAtIso: iso(gen),
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
    status: p.lease === "draft" ? "Draft" : "Manager Review",
    stageLabel: p.lease === "draft" ? "Draft" : "Manager Review",
    currentActorRole: "manager",
  };
  if (p.lease === "draft" || p.lease === "manager") return base;
  if (p.lease === "resident") {
    return { ...base, bucket: "resident", status: "Resident Signature Pending", stageLabel: "Resident Signature Pending", currentActorRole: "resident", sentToResidentAt: iso(sent) };
  }
  const resSig = { name: p.name, signedAtIso: iso(resSign), role: "resident" };
  if (p.lease === "manager_sign") {
    return {
      ...base,
      bucket: "signed",
      status: "Manager Signature Pending",
      stageLabel: "Manager Signature Pending",
      currentActorRole: "manager",
      sentToResidentAt: iso(sent),
      residentSignature: resSig,
      signatureName: p.name,
      signedAtIso: iso(resSign),
      residentSignedAt: iso(resSign),
    };
  }
  return {
    ...base,
    bucket: "signed",
    status: "Fully Signed",
    stageLabel: "Signed",
    currentActorRole: "system",
    sentToResidentAt: iso(sent),
    residentSignature: resSig,
    managerSignature: { name: MANAGER_NAME, signedAtIso: iso(mgrSign), role: "manager" },
    signatureName: p.name,
    signedAtIso: iso(resSign),
    residentSignedAt: iso(resSign),
    managerSignedAt: iso(mgrSign),
    fullySignedAt: iso(mgrSign),
  };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Rent is due on this day each month: four days out, so one pending bucket is always populated. */
const DUE_DAY = Math.min(28, daysFromNow(4).getDate());
/** The month whose due day is still ahead of today (the "pending" month). */
const CURRENT_MONTH = (() => {
  const d = daysFromNow(4);
  return { y: d.getFullYear(), m: d.getMonth() };
})();
const monthRel = (n) => {
  const d = new Date(CURRENT_MONTH.y, CURRENT_MONTH.m + n, 1);
  return { ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, name: MONTH_NAMES[d.getMonth()], y: d.getFullYear(), m: d.getMonth() };
};

function rentCharge(p, managerUserId, monthRelN, status) {
  const mo = monthRel(monthRelN);
  const emailKey = chargeKeyPart(p.email);
  const propKey = chargeKeyPart(p.prop);
  const amount = money(p.rent);
  const due = new Date(mo.y, mo.m, DUE_DAY, 12);
  const paidAt = status === "paid" ? iso(new Date(due.getTime() - 2 * DAY)) : undefined;
  return {
    id: `hc_rent_${emailKey}_${propKey}_${mo.ym}`,
    createdAt: iso(new Date(due.getTime() - 20 * DAY)),
    applicationId: p.axisId,
    residentEmail: p.email,
    residentName: p.name,
    residentUserId: p.userId ?? null,
    propertyId: p.prop,
    propertyLabel: p.propData.name,
    managerUserId,
    kind: "rent",
    title: `${mo.name} rent`,
    amountLabel: amount,
    balanceLabel: status === "paid" ? "$0.00" : amount,
    status,
    blocksLeaseUntilPaid: false,
    dueDateLabel: `Due ${isoDate(due)}`,
    rentMonth: mo.ym,
    recurringRentProfileId: `seed-rent-${emailKey}-${propKey}`,
    dueDay: DUE_DAY,
    ...(paidAt ? { paidAt, paidMethod: "ach" } : {}),
  };
}

function fixedCharge(p, managerUserId, kind, title, amount, status, daysOffset) {
  const axisKey = chargeKeyPart(p.axisId);
  const due = daysFromNow(daysOffset);
  const amt = money(amount);
  return {
    id: `hc_app_${axisKey}_${kind}`,
    createdAt: iso(daysFromNow(daysOffset - 5)),
    applicationId: p.axisId,
    residentEmail: p.email,
    residentName: p.name,
    residentUserId: p.userId ?? null,
    propertyId: p.prop,
    propertyLabel: p.propData.name,
    managerUserId,
    kind,
    title,
    amountLabel: amt,
    balanceLabel: status === "paid" ? "$0.00" : amt,
    status,
    blocksLeaseUntilPaid: kind === "security_deposit" && status !== "paid",
    dueDateLabel: `Due ${isoDate(due)}`,
    ...(status === "paid" ? { paidAt: iso(daysFromNow(daysOffset - 1)), paidMethod: "ach" } : {}),
  };
}

/** Which rent charges each resident carries, mirroring the home page's Payments rows. */
const RENT_PLAN = {
  jordan: [[0, "pending"], [-1, "paid"]],
  priya: [[0, "paid"], [-1, "paid"], [-2, "paid"], [-3, "paid"]],
  tomas: [[0, "paid"], [-1, "paid"], [-2, "paid"]],
  liam: [[0, "pending"], [-1, "overdue"], [-2, "paid"]],
  maya: [[0, "pending"], [-1, "overdue"]],
  dana: [[0, "pending"], [-1, "paid"], [-2, "paid"]],
  luis: [[0, "paid"], [-1, "paid"], [-2, "paid"]],
};

/* ───────────────────────────── Main ───────────────────────────── */

async function main() {
  console.log(`Seeding the showcase world into ${ref} (dev/test)`);

  // Health check first: one cheap select. Stop if the shared dev DB is slow.
  const t0 = Date.now();
  const health = await supabase.from("profiles").select("id").limit(1);
  const took = Date.now() - t0;
  if (health.error || took > 5000) {
    console.error(`ABORT: dev DB health check ${health.error ? `failed (${health.error.message})` : `took ${took}ms (>5000ms)`}. Not seeding.`);
    process.exit(2);
  }
  console.log(`  db health ok (${took}ms)`);

  /* 1. Manager account, plan, workspace */
  const managerAxis = "MGR-SHOWCASE";
  const managerUserId = await ensureShowcaseUser(MANAGER_EMAIL, MANAGER_PASSWORD, "manager", {
    managerId: managerAxis,
    fullName: MANAGER_NAME,
  });
  console.log(`  manager ${MANAGER_EMAIL}`);

  const purchasePatch = { tier: "business", billing: "portal", promo_code: "FREE100", paid_at: iso(NOW), email: MANAGER_EMAIL, user_id: managerUserId };
  const existingPurchase = await must(supabase.from("manager_purchases").select("id").eq("user_id", managerUserId).maybeSingle(), "manager_purchases(select)");
  if (existingPurchase?.id) {
    await must(supabase.from("manager_purchases").update(purchasePatch).eq("id", existingPurchase.id), "manager_purchases(update)");
  } else {
    await must(
      supabase.from("manager_purchases").upsert(
        { ...purchasePatch, manager_id: managerAxis, stripe_checkout_session_id: "seed_showcase_manager" },
        { onConflict: "manager_id" },
      ),
      "manager_purchases(insert)",
    );
  }

  const workspaceId = await must(supabase.rpc("ensure_default_portal_workspace", { p_owner: managerUserId }), "ensure_default_portal_workspace");
  await must(supabase.from("portal_workspaces").update({ name: WORKSPACE_NAME }).eq("id", workspaceId), "portal_workspaces(rename)");

  const settingsRow = await must(
    supabase.from("manager_automation_settings").select("row_data").eq("manager_user_id", managerUserId).maybeSingle(),
    "manager_automation_settings(select)",
  );
  const settings = settingsRow?.row_data && typeof settingsRow.row_data === "object" ? { ...settingsRow.row_data } : {};
  settings.landlordProfile = { ...(settings.landlordProfile ?? {}), landlordLegalName: `${WORKSPACE_NAME} LLC` };
  settings.googleServicesOnboarding = { dismissedAt: iso(NOW) };
  await must(
    supabase.from("manager_automation_settings").upsert({ manager_user_id: managerUserId, row_data: settings, updated_at: iso(NOW) }, { onConflict: "manager_user_id" }),
    "manager_automation_settings(upsert)",
  );

  /* 2. Resident account. Only Jordan logs in; the other residents are rows keyed by the
   *    fixtures' own example.com emails (some of which belong to other seeds' accounts, so no
   *    auth user is created or touched for them). */
  const jordanP = person("jordan");
  jordanP.userId = await ensureShowcaseUser(jordanP.email, RESIDENT_PASSWORD, "resident", {
    managerId: jordanP.axisId,
    fullName: jordanP.name,
  });
  console.log(`  resident ${RESIDENT_EMAIL}`);
  // The resident portal resolves "my manager's plan" by looking up profiles.manager_id (the
  // resident's own AXIS id) in manager_purchases; with no row it reads Free and paywalls
  // Services and Documents. A paid, userless row under that id keeps those sections open.
  await must(
    supabase.from("manager_purchases").upsert(
      { manager_id: jordanP.axisId, email: RESIDENT_EMAIL, tier: "business", billing: "portal", promo_code: "FREE100", paid_at: iso(NOW), stripe_checkout_session_id: "seed_showcase_resident_tier" },
      { onConflict: "manager_id" },
    ),
    "manager_purchases(resident tier lookup)",
  );

  /* 3. Scoped cleanup: only the showcase manager's rows */
  const MANAGER_TABLES = [
    "manager_property_records",
    "manager_application_records",
    "portal_household_charge_records",
    "portal_recurring_rent_profile_records",
    "portal_lease_pipeline_records",
    "portal_service_request_records",
    "portal_work_order_records",
  ];
  for (const table of MANAGER_TABLES) {
    await must(supabase.from(table).delete().eq("manager_user_id", managerUserId), `clean ${table}`);
  }
  await must(supabase.from("portal_inbox_thread_records").delete().eq("owner_user_id", managerUserId), "clean inbox");

  /* 4. Properties */
  const propertyRows = PROPERTIES.map((p) => {
    const submission = buildListingSubmission(p, managerUserId);
    const rents = p.rooms.map((r) => r.rent);
    const lo = Math.min(...rents);
    const hi = Math.max(...rents);
    return {
      id: p.id,
      manager_user_id: managerUserId,
      workspace_id: workspaceId,
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
        rentLabel: lo === hi ? `${usdWhole(lo)} / mo` : `${usdWhole(lo)}-${usdWhole(hi)} / mo`,
        available: "Now",
        petFriendly: p.petFriendly,
        buildingId: `${p.id}-bld`,
        buildingName: p.name,
        unitLabel: `${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"}`,
        mapLat: 47.65,
        mapLng: -122.34,
        managerUserId,
        adminPublishLive: true,
        listingSubmission: submission,
      },
      row_data: { id: p.id, status: "live", name: p.name, buildingName: p.name, address: p.address },
      updated_at: iso(NOW),
    };
  });
  await put("manager_property_records", "upsert", propertyRows, "id", "manager_property_records");
  console.log(`  ${propertyRows.length} properties`);

  /* 5. Applications */
  const monthDay = (d) => d.toLocaleString("en-US", { month: "short", day: "numeric" });
  const applicationRows = PEOPLE.map((p) => {
    const submittedAt = daysFromNow(p.submittedDays ?? (p.since ?? 0) - 8);
    const incomplete = p.bucket === "incomplete";
    const stage = p.past ? "Moved out" : p.bucket === "approved" ? "Approved - placed" : p.bucket === "rejected" ? "Rejected" : incomplete ? "In progress" : "Submitted";
    const detail =
      p.past
        ? `Moved out ${monthDay(daysFromNow(p.end))}`
        : p.bucket === "approved"
        ? `Approved for ${p.roomData.name}`
        : p.bucket === "rejected"
          ? "Income did not meet the requirement."
          : incomplete
            ? `Started ${monthDay(submittedAt)}`
            : `Submitted ${monthDay(submittedAt)}`;
    const application = cleanApplication(p);
    if (incomplete) application.consentCredit = false;
    const row = {
      id: p.axisId,
      axisId: p.axisId,
      // An incomplete draft is a pending row in stage "In progress"; the list labels it Incomplete.
      bucket: incomplete ? "pending" : p.bucket,
      stage,
      detail,
      email: p.email,
      name: p.name,
      property: p.propData.name,
      application,
      managerUserId,
      propertyId: p.prop,
    };
    const check = (result) => ({
      provider: "checkr",
      candidateId: `seed-cand-${p.axisId.toLowerCase()}`,
      reportId: `seed-report-${p.axisId.toLowerCase()}`,
      packageSlug: "test_pro_criminal",
      status: "complete",
      result,
      assessment: result === "clear" ? "eligible" : "review",
      orderedAt: iso(daysFromNow((p.submittedDays ?? (p.since ?? 0) - 7) + 1)),
      completedAt: iso(daysFromNow((p.submittedDays ?? (p.since ?? 0) - 6) + 2)),
      simulated: true,
    });
    if (p.past) {
      row.manualResidentDetails = { moveInDate: isoDate(daysFromNow(p.since)), moveOutDate: isoDate(daysFromNow(p.end)) };
    }
    if (p.bucket === "approved") {
      Object.assign(row, {
        backgroundCheck: check("clear"),
        backgroundCheckStatus: "passed",
        residentUserId: p.userId ?? null,
        assignedPropertyId: p.prop,
        assignedRoomChoice: p.roomChoice,
        signedMonthlyRent: p.rent,
      });
    } else if (p.screening) {
      Object.assign(row, {
        backgroundCheck: check(p.screening === "flagged" ? "consider" : "clear"),
        backgroundCheckStatus: p.screening === "flagged" ? "flagged" : "passed",
      });
    } else {
      row.backgroundCheckStatus = "pending_review";
    }
    return {
      id: p.axisId,
      manager_user_id: managerUserId,
      resident_email: p.email,
      property_id: p.prop,
      assigned_property_id: p.bucket === "approved" ? p.prop : null,
      row_data: row,
      updated_at: iso(NOW),
    };
  });
  // One at a time: the room-capacity trigger evaluates each approved row against the others, so
  // insertion order must respect it (and a failure names the person).
  for (const row of applicationRows) {
    // The shared dev DB occasionally cancels a statement under load; retry before failing.
    for (let attempt = 1; ; attempt++) {
      try {
        await must(supabase.from("manager_application_records").upsert(row, { onConflict: "id" }), `manager_application_records(${row.row_data.name})`);
        break;
      } catch (err) {
        if (attempt >= 3 || !/statement timeout/i.test(String(err))) throw err; // cap: 2 retries
        await sleep(2000 * attempt);
      }
    }
  }
  console.log(`  ${applicationRows.length} applications`);

  /* 6. Leases */
  person("mason").lease = "draft";
  const leasePeople = PEOPLE.filter((p) => p.lease);
  const leaseRows = leasePeople.map((p) => {
    const html = p.lease === "draft" ? null : buildLeaseHtml(p, managerUserId);
    const row = buildLeaseRow(p, managerUserId, html);
    return {
      id: row.id,
      manager_user_id: managerUserId,
      resident_user_id: p.userId ?? null,
      resident_email: p.email,
      property_id: p.prop,
      status: row.bucket,
      row_data: { ...row },
      updated_at: iso(NOW),
    };
  });
  await put("portal_lease_pipeline_records", "upsert", leaseRows, "id", "portal_lease_pipeline_records");
  console.log(`  ${leaseRows.length} leases`);

  /* 7. Charges + rent profiles */
  const chargeRows = [];
  const profileRows = [];
  for (const [key, plan] of Object.entries(RENT_PLAN)) {
    const p = person(key);
    for (const [rel, status] of plan) chargeRows.push(householdChargeDbRow(rentCharge(p, managerUserId, rel, status)));
    if ((p.lease === "signed" || p.lease === "manager_sign") && !p.past) {
      const sinceMonth = (() => {
        const d = daysFromNow(p.since ?? 0);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      })();
      const profile = {
        id: `seed-rent-${chargeKeyPart(p.email)}-${chargeKeyPart(p.prop)}`,
        residentEmail: p.email,
        residentName: p.name,
        residentUserId: p.userId ?? null,
        propertyId: p.prop,
        propertyLabel: p.propData.name,
        roomLabel: p.roomData.name,
        managerUserId,
        monthlyRent: p.rent,
        monthlyUtilities: 0,
        dueDay: DUE_DAY,
        startMonth: sinceMonth > monthRel(-2).ym ? sinceMonth : monthRel(-2).ym,
        leaseEnd: p.end != null ? isoDate(daysFromNow(p.end)) : isoDate(daysFromNow((p.since ?? 0) + 365)),
        active: !p.past,
        updatedAt: iso(NOW),
      };
      profileRows.push(rentProfileDbRow(profile));
    }
  }
  // Every submitted applicant paid the application fee (the app would otherwise generate a pending one).
  for (const p of PEOPLE.filter((x) => x.bucket !== "incomplete")) {
    const fee = fixedCharge(p, managerUserId, "application_fee", "Application fee", 50, "paid", (p.submittedDays ?? (p.since ?? 0) - 8) + 1);
    fee.id = `hc_app_fee_${chargeKeyPart(p.axisId)}`;
    chargeRows.push(householdChargeDbRow(fee));
  }
  // Move-in charges, already paid, so Payments reads like a real move-in (and the app has nothing to regenerate).
  for (const who of PEOPLE.filter((x) => x.lease === "signed" && !x.past)) {
    for (const [kind, title, amount] of [
      ["security_deposit", "Security deposit", who.propData.deposit],
      ["first_month_rent", "First month rent", who.rent],
      ["move_in_fee", "Move-in fee", 250],
    ]) {
      chargeRows.push(householdChargeDbRow(fixedCharge(who, managerUserId, kind, title, amount, "paid", (who.since ?? 0) - 5)));
    }
  }
  await put("portal_household_charge_records", "upsert", chargeRows, "id", "portal_household_charge_records");
  await put("portal_recurring_rent_profile_records", "upsert", profileRows, "id", "portal_recurring_rent_profile_records");
  console.log(`  ${chargeRows.length} charges, ${profileRows.length} rent profiles`);

  await seedRest({ managerUserId, workspaceId });

  console.log(`
Showcase world seeded into ${ref}

  manager   ${MANAGER_EMAIL} / ${MANAGER_PASSWORD}
  resident  ${RESIDENT_EMAIL} / ${RESIDENT_PASSWORD}
  vendor    ${VENDOR_EMAIL} / ${VENDOR_PASSWORD}
`);
}


/* ───────────────────────────── Part 3 helpers ───────────────────────────── */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** "Oct 5, 3:30 PM" in Pacific time: the exact shape `formatInboxStamp` produces. */
function stamp(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
/** "Thu 10:00 AM" label for a service visit. */
function visitLabel(date) {
  return date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" });
}
/** A local wall-clock time `d` days from today. */
function at(d, hour, minute = 0) {
  const x = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + d, hour, minute, 0, 0);
  return x;
}
const cents = (dollars) => Math.round(dollars * 100);
const uuid = () => crypto.randomUUID();

/** A one-page PDF with a title and a few lines, so storage-backed document rows have real bytes. */
function tinyPdf(title, lines = []) {
  const esc = (s) => s.replace(/[()\\]/g, (c) => `\\${c}`);
  const content = [
    "BT /F1 20 Tf 72 720 Td (" + esc(title) + ") Tj ET",
    ...lines.map((l, i) => `BT /F1 12 Tf 72 ${690 - i * 20} Td (${esc(l)}) Tj ET`),
  ].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ensuredBuckets = new Set();
/** Private bucket, created only when the dev/test project lacks it (its migration may not have run there). */
async function ensureBucket(bucket) {
  if (ensuredBuckets.has(bucket)) return;
  ensuredBuckets.add(bucket);
  const { data } = await supabase.storage.getBucket(bucket);
  if (data) return;
  const { error } = await supabase.storage.createBucket(bucket, { public: false });
  if (error) console.warn(`  (bucket ${bucket} not created: ${error.message})`);
  else console.log(`  created private bucket ${bucket} on dev/test`);
}

async function uploadPdf(bucket, objectPath, title, lines) {
  await ensureBucket(bucket);
  const bytes = tinyPdf(title, lines);
  const { error } = await supabase.storage.from(bucket).upload(objectPath, bytes, { contentType: "application/pdf", upsert: true });
  if (error) {
    console.warn(`  (storage ${bucket}/${objectPath} skipped: ${error.message})`);
    return null;
  }
  return bytes.length;
}

/** Add `items` to a shared schedule singleton, first dropping any this manager wrote on an earlier run. */
async function mergeSingleton(id, managerUserId, items, ownedBy = (item) => item.managerUserId === managerUserId) {
  const { data: existing, error } = await supabase
    .from("portal_schedule_records")
    .select("id,row_data,manager_user_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`select ${id}: ${error.message}`);
  const current = Array.isArray(existing?.row_data?.payload) ? existing.row_data.payload : [];
  const kept = current.filter((item) => !ownedBy(item));
  await must(
    supabase.from("portal_schedule_records").upsert(
      {
        id,
        manager_user_id: existing?.manager_user_id ?? managerUserId,
        record_type: id,
        row_data: { id, recordType: id, managerUserId: existing?.row_data?.managerUserId ?? managerUserId, payload: [...kept, ...items] },
        updated_at: iso(NOW),
      },
      { onConflict: "id" },
    ),
    `portal_schedule_records(${id})`,
  );
}

function slotIso(date) {
  return date.toISOString();
}
/** Half-hour slot index for a Date's local wall time, as the tour grid keys it (`YYYY-MM-DD:slot`). */
function slotKeyFor(date) {
  const ds = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${ds}:${date.getHours() * 2 + (date.getMinutes() >= 30 ? 1 : 0)}`;
}

/* ───────────────────────────── Part 3: everything past charges ───────────────────────────── */

async function seedRest({ managerUserId, workspaceId }) {
  const mgrPerson = { name: MANAGER_NAME, email: MANAGER_EMAIL };
  const rooms = (p) => ({ propertyName: p.propData.name, unit: p.roomData.name, address: p.propData.address });

  /* ── Vendor account + directory ── */
  const vendorUserId = await ensureShowcaseUser(VENDOR_EMAIL, VENDOR_PASSWORD, "vendor", {
    managerId: "AXIS-SHOWVENDOR",
    fullName: "Vendor",
  });
  console.log(`  vendor ${VENDOR_EMAIL}`);

  // Reverse-FK cleanup of this manager's vendor-side rows (payouts → invoices → reviews → work orders).
  await must(supabase.from("manager_expense_entries").delete().eq("manager_user_id", managerUserId), "clean expenses");
  await must(supabase.from("vendor_reviews").delete().eq("manager_user_id", managerUserId), "clean vendor_reviews");
  await must(supabase.from("vendor_payouts").delete().eq("manager_user_id", managerUserId), "clean vendor_payouts");
  await must(supabase.from("vendor_invoices").delete().eq("manager_user_id", managerUserId), "clean vendor_invoices");
  await must(supabase.from("manager_payees").delete().eq("manager_user_id", managerUserId), "clean payees");
  await must(supabase.from("ledger_entries").delete().eq("manager_user_id", managerUserId), "clean ledger");
  await must(supabase.from("security_deposit_ledger").delete().eq("manager_user_id", managerUserId), "clean deposit ledger");
  await must(supabase.from("manager_vendor_records").delete().eq("manager_user_id", managerUserId), "clean vendors");
  await must(supabase.from("resident_move_in_forms").delete().eq("manager_user_id", managerUserId), "clean forms");
  await must(supabase.from("manager_promotion_records").delete().eq("manager_user_id", managerUserId), "clean promotion");
  await must(supabase.from("manager_documents").delete().eq("manager_user_id", managerUserId), "clean documents");
  // The shared singletons (planned events, partner inquiries) hold other managers' items too: never delete them,
  // mergeSingleton below only swaps out this manager's own entries.
  await must(
    supabase
      .from("portal_schedule_records")
      .delete()
      .eq("manager_user_id", managerUserId)
      .not("id", "in", "(axis_admin_planned_events_v1,axis_admin_partner_inquiries_v1)"),
    "clean schedule",
  );
  await must(supabase.from("vendor_availability_rules").delete().eq("vendor_user_id", vendorUserId), "clean availability");
  await must(supabase.from("portal_inbox_thread_records").delete().eq("owner_user_id", vendorUserId), "clean vendor inbox");
  await must(supabase.from("portal_inbox_thread_records").delete().eq("owner_user_id", person("jordan").userId), "clean resident inbox");

  const VENDORS = [
    { key: "pacific", id: "showcase-vendor-pacific", name: "Pacific Plumbing", trade: "Plumbing", phone: "(206) 555-0142", email: "office@pacificplumbing.example", priority: "primary", userId: vendorUserId },
    { key: "cascade", id: "showcase-vendor-cascade", name: "Cascade Locksmiths", trade: "Locksmith", phone: "(206) 555-0177", email: "dispatch@cascadelocks.example", priority: "secondary" },
    { key: "evergreen", id: "showcase-vendor-evergreen", name: "Evergreen Electric", trade: "Electrical", phone: "(206) 555-0156", email: "jobs@evergreenelectric.example", priority: "secondary" },
    { key: "rainier", id: "showcase-vendor-rainier", name: "Rainier Cleaning", trade: "Cleaning", phone: "(206) 555-0124", email: "hello@rainiercleaning.example", priority: null, inactive: true },
  ];
  const vendor = Object.fromEntries(VENDORS.map((v) => [v.key, v]));
  const propertyIds = PROPERTIES.map((p) => p.id);
  const docPrefix = `vendor-documents/${vendorUserId}`;
  const vendorDocs = [
    { kind: "w9", fileName: "W-9 Pacific Plumbing.pdf", title: "Form W-9", lines: ["Pacific Plumbing", "Taxpayer identification (sample)"] },
    { kind: "insurance", fileName: "Certificate of insurance.pdf", title: "Certificate of Liability Insurance", lines: ["Pacific Plumbing", "General liability, $1,000,000 per occurrence"] },
    { kind: "license", fileName: "Plumbing contractor license.pdf", title: "Washington Contractor License", lines: ["Pacific Plumbing", "License PACIFPL123QX"] },
  ];
  const vendorDocRows = [];
  for (const d of vendorDocs) {
    const storagePath = `${docPrefix}/${d.kind}-${d.fileName.replace(/[^A-Za-z0-9.]+/g, "-")}`;
    const size = await uploadPdf("vendor-documents", storagePath, d.title, d.lines);
    if (size != null) {
      vendorDocRows.push({
        kind: d.kind,
        fileName: d.fileName,
        url: `/api/vendor/documents/signed-url?kind=${d.kind}`,
        storagePath,
        uploadedAt: iso(daysFromNow(-40)),
        ...(d.kind === "insurance" ? { expiresAt: isoDate(daysFromNow(200)) } : {}),
      });
    }
  }
  await must(
    supabase.from("manager_vendor_records").upsert(
      VENDORS.map((v) => ({
        id: v.id,
        manager_user_id: managerUserId,
        vendor_user_id: v.userId ?? null,
        row_data: {
          id: v.id,
          managerUserId,
          name: v.name,
          trade: v.trade,
          trades: [v.trade],
          phone: v.phone,
          email: v.email,
          notes: "",
          active: !v.inactive,
          propertyIds,
          ...(v.priority ? { vendorPriority: v.priority } : {}),
          ...(v.userId ? { vendorUserId: v.userId, vendorDocuments: vendorDocRows, insuranceProvider: "Evergreen Mutual", insurancePolicyNumber: "EM-448120", insuranceExpiresAt: isoDate(daysFromNow(200)) } : {}),
        },
        updated_at: iso(NOW),
      })),
      { onConflict: "id" },
    ),
    "manager_vendor_records",
  );
  await must(
    supabase.from("vendor_business_profiles").upsert(
      {
        user_id: vendorUserId,
        business_name: "Pacific Plumbing",
        contact_name: "Vendor",
        work_email: "office@pacificplumbing.example",
        work_phone: "(206) 555-0142",
        service_area: "Seattle, WA",
        trades: ["Plumbing"],
        service_area_zips: ["98103", "98107", "98122"],
        service_radius_miles: 25,
        license_number: "PACIFPL123QX",
        insurance_provider: "Evergreen Mutual",
        insurance_policy_number: "EM-448120",
        insurance_expires_at: isoDate(daysFromNow(200)),
        directory_listed: true,
        onboarding_completed_at: iso(daysFromNow(-60)),
      },
      { onConflict: "user_id" },
    ),
    "vendor_business_profiles",
  );
  const availability = [];
  for (const weekday of [1, 2, 3, 4, 5]) availability.push({ vendor_user_id: vendorUserId, kind: "weekly", weekday, start_minute: 9 * 60, end_minute: 17 * 60 });
  availability.push({ vendor_user_id: vendorUserId, kind: "open", specific_date: isoDate(daysFromNow(5)), start_minute: 10 * 60, end_minute: 14 * 60 });
  availability.push({ vendor_user_id: vendorUserId, kind: "block", specific_date: isoDate(daysFromNow(4)), start_minute: 12 * 60, end_minute: 13 * 60, note: "Lunch" });
  await put("vendor_availability_rules", "insert", availability, null);
  {
    // The "event" kind needs migration 20260706220000, which the dev DB may not have yet.
    const { error } = await supabase
      .from("vendor_availability_rules")
      .insert({ vendor_user_id: vendorUserId, kind: "event", specific_date: isoDate(daysFromNow(3)), start_minute: 13 * 60, end_minute: 14 * 60, note: "Supply run" });
    if (error) console.warn(`  (vendor calendar event skipped: ${error.message})`);
  }

  /* ── Work orders ── */
  // state: open | assigned | scheduled | done_paid | done_topay. who: person key; v: vendor key.
  const WOS = [
    { id: "hotwater", who: "dana", title: "No hot water", cat: "plumbing", desc: "No hot water at the sink or shower since last night.", state: "open", v: "pacific", offer: true, bid: { cents: cents(240), status: "submitted" }, reportedDays: 0 },
    { id: "pressure", who: "tomas", title: "Low water pressure upstairs", cat: "plumbing", desc: "The upstairs shower barely runs.", state: "open", v: "pacific", offer: true, reportedDays: -1 },
    { id: "shower", who: "priya", title: "Leaking shower valve", cat: "plumbing", desc: "Valve drips even when the shower is off.", state: "assigned", v: "pacific", bid: { cents: cents(160), status: "accepted" }, reportedDays: -3 },
    { id: "hallway", who: "tomas", title: "Hallway light flickers", cat: "electrical", desc: "The hallway ceiling light flickers and buzzes.", state: "assigned", v: "evergreen", reportedDays: -2 },
    { id: "alderfaucet", who: "liam", title: "Kitchen faucet drip", cat: "plumbing", desc: "Kitchen faucet drips overnight.", state: "scheduled", v: "pacific", visit: at(2, 10), cost: cents(90), bid: { cents: cents(90), status: "accepted" }, reportedDays: -4 },
    { id: "jordanfaucet", who: "jordan", title: "Kitchen faucet", cat: "plumbing", desc: "The kitchen faucet is dripping. Water is collecting under the cabinet.", state: "scheduled", v: "pacific", visit: at(1, 9), cost: cents(180), bid: { cents: cents(180), status: "accepted" }, reportedDays: -2 },
    { id: "lockout", who: "maya", title: "Locked out: front door", cat: "access", desc: "Locked out of the front door.", state: "scheduled", v: "cascade", visit: at(0, 15), reportedDays: 0 },
    { id: "blinds", who: "luis", title: "Broken blinds", cat: "general", desc: "The bedroom blinds will not stay up.", state: "done_paid", v: null, completedDays: -19, reportedDays: -24 },
    { id: "smoke", who: "liam", title: "Smoke detector battery", cat: "general", desc: "Smoke detector chirps every minute.", state: "done_paid", v: null, completedDays: -28, reportedDays: -29 },
    { id: "drain", who: "maya", title: "Slow bathroom drain", cat: "plumbing", desc: "Bathroom sink drains slowly.", state: "done_paid", v: "pacific", completedDays: -22, cost: cents(140), invoice: { n: "INV-1012", status: "paid" }, review: { stars: 5, body: "Showed up in the window, fixed the drain in one visit, and left the bathroom spotless.", reply: "Thank you, glad it's running clear." }, reportedDays: -26 },
    { id: "disposal", who: "luis", title: "Garbage disposal repair", cat: "appliance", desc: "Disposal hums but does not spin.", state: "done_topay", v: "pacific", completedDays: -15, cost: cents(210), invoice: { n: "INV-1015", status: "approved" }, review: { stars: 4, body: "Good work on the disposal. Arrived 20 minutes after the window started." }, reportedDays: -19 },
    { id: "heater", who: "liam", title: "Water heater flush", cat: "plumbing", desc: "Annual water heater flush.", state: "done_paid", v: "pacific", completedDays: -40, cost: cents(95), invoice: { n: "INV-1009", status: "paid" }, review: { stars: 5, body: "Explained what had failed and what it would cost before touching anything." }, reportedDays: -44 },
    { id: "toilet", who: "tomas", title: "Running toilet", cat: "plumbing", desc: "Toilet runs constantly after flushing.", state: "done_topay", v: "pacific", completedDays: -35, cost: cents(120), invoice: { n: "INV-1016", status: "scheduled" }, review: { stars: 5, body: "Clear quote up front and no surprises on the invoice.", reply: "Appreciate it. Happy to help anytime." }, reportedDays: -38 },
    { id: "cartridge", who: "priya", title: "Bathroom faucet cartridge", cat: "plumbing", desc: "Bathroom faucet will not shut off fully.", state: "done_paid", v: "pacific", completedDays: -49, cost: cents(85), jobPayout: true, review: { stars: 5, body: "Water heater flush done quickly. Would book again.", reply: "Thanks for the kind words." }, reportedDays: -52 },
    { id: "hosebib", who: "maya", title: "Hose bib replacement", cat: "plumbing", desc: "Outdoor hose bib leaks at the handle.", state: "done_paid", v: "pacific", completedDays: -62, cost: cents(75), jobPayout: true, review: { stars: 5, body: "Polite, on time, and tidy." }, reportedDays: -65 },
  ];

  const woRows = [];
  const offerRows = [];
  const bidRows = [];
  const invoiceRows = [];
  const payoutRows = [];
  const reviewRows = [];
  const expenseRows = [];
  for (const w of WOS) {
    const p = person(w.who);
    const woId = `showcase-wo-${w.id}`;
    const v = w.v ? vendor[w.v] : null;
    const reported = daysFromNow(w.reportedDays ?? 0);
    const visit = w.visit ?? (w.completedDays != null ? daysFromNow(w.completedDays) : null);
    const doneAt = w.completedDays != null ? daysFromNow(w.completedDays) : null;
    const row = {
      id: woId,
      managerUserId,
      propertyId: p.prop,
      assignedPropertyId: p.prop,
      assignedRoomChoice: p.roomChoice,
      propertyName: p.propData.name,
      unit: p.roomData.name,
      propertyAddress: p.propData.address,
      title: w.title,
      description: w.desc,
      priority: w.id === "hotwater" ? "High" : "Normal",
      category: w.cat,
      status: w.state === "open" || w.state === "assigned" ? "Open" : w.state === "scheduled" ? "Scheduled" : "Completed",
      bucket: w.state === "scheduled" ? "scheduled" : w.state.startsWith("done") ? "completed" : "open",
      scheduled: visit ? visitLabel(visit) : "Unscheduled",
      cost: w.cost ? usd(w.cost / 100) : "—",
      residentName: p.name,
      residentEmail: p.email,
      preferredArrival: "Weekday mornings",
      entryPermission: "call_first",
      createdAt: iso(reported),
      requestedAt: iso(reported),
    };
    if (v) {
      Object.assign(row, {
        vendorId: v.id,
        vendorName: v.name,
        vendorAssignedAt: iso(new Date(reported.getTime() + 2 * HOUR)),
        assignee: { type: "vendor", id: v.id, name: v.name },
      });
      if (v.userId) row.vendorUserId = v.userId;
    } else if (w.state.startsWith("done")) {
      row.selfAssigned = true;
      row.assignee = { type: "team", id: managerUserId, name: MANAGER_NAME };
    }
    if (visit && w.state !== "open") row.scheduledAtIso = iso(visit);
    if (w.offer) {
      Object.assign(row, { biddingOpen: true, biddingOpenedAt: iso(new Date(reported.getTime() + HOUR)), offerSharePhotos: false });
      delete row.assignee;
      delete row.vendorId;
      delete row.vendorName;
      delete row.vendorUserId;
      delete row.vendorAssignedAt;
    }
    if (w.state.startsWith("done")) {
      Object.assign(row, {
        completedAt: iso(doneAt),
        workDoneSummary: "Completed and cleaned up.",
        ...(w.cost ? { vendorCostCents: w.cost, materialsCostCents: 0, vendorPriceSetAt: iso(doneAt) } : {}),
      });
      if (w.state === "done_paid") Object.assign(row, { automationStatus: "paid", paidAt: iso(new Date(doneAt.getTime() + 2 * DAY)), ...(v ? { vendorPaymentChannel: "balance" } : {}) });
      else Object.assign(row, { automationStatus: "vendor_marked_done", vendorMarkedDoneAt: iso(doneAt) });
    }
    woRows.push({
      id: woId,
      manager_user_id: managerUserId,
      resident_email: p.email,
      property_id: p.prop,
      assigned_property_id: p.prop,
      vendor_user_id: v?.userId ?? null,
      row_data: row,
      updated_at: iso(NOW),
    });
    if (w.offer) {
      offerRows.push({ id: uuid(), work_order_id: woId, vendor_directory_id: v.id, vendor_user_id: v.userId ?? null, manager_user_id: managerUserId, status: "sent" });
    }
    if (w.bid) {
      bidRows.push({
        id: uuid(),
        work_order_id: woId,
        vendor_user_id: v.userId,
        vendor_directory_id: v.id,
        manager_user_id: managerUserId,
        amount_cents: w.bid.cents,
        materials_cents: 0,
        quote_mode: "upfront",
        proposed_time: w.visit && w.bid.status === "accepted" ? iso(w.visit) : null,
        note: "Includes parts and cleanup.",
        status: w.bid.status,
        bid_submitted_at: iso(new Date(reported.getTime() + 3 * HOUR)),
        created_at: iso(new Date(reported.getTime() + 3 * HOUR)),
        updated_at: iso(new Date(reported.getTime() + 4 * HOUR)),
      });
    }
    if (w.invoice) {
      const invId = uuid();
      const paid = w.invoice.status === "paid";
      invoiceRows.push({
        id: invId,
        manager_user_id: managerUserId,
        vendor_user_id: v.userId,
        vendor_id: v.id,
        work_order_id: woId,
        invoice_number: w.invoice.n,
        line_items: [{ description: w.title, quantity: 1, unitAmountCents: w.cost, amountCents: w.cost }],
        subtotal_cents: w.cost,
        tax_cents: 0,
        total_cents: w.cost,
        currency: "usd",
        status: w.invoice.status,
        memo: w.title,
        submitted_at: iso(new Date(doneAt.getTime() + 3 * HOUR)),
        decided_at: iso(new Date(doneAt.getTime() + DAY)),
        decided_by: managerUserId,
        ...(w.invoice.status === "scheduled" ? { scheduled_for: isoDate(daysFromNow(3)) } : {}),
        ...(paid ? { paid_at: iso(new Date(doneAt.getTime() + 2 * DAY)), paid_from: "balance", payment_claim: "balance" } : {}),
        created_at: iso(new Date(doneAt.getTime() + 3 * HOUR)),
        updated_at: iso(new Date(doneAt.getTime() + 2 * DAY)),
      });
      if (paid) {
        payoutRows.push({
          id: uuid(),
          manager_user_id: managerUserId,
          vendor_user_id: v.userId,
          work_order_id: woId,
          invoice_id: invId,
          amount_cents: w.cost,
          status: "paid",
          stripe_transfer_id: `tr_showcase_${w.id}`,
          platform_fee_cents: 0,
          created_at: iso(new Date(doneAt.getTime() + 2 * DAY)),
          updated_at: iso(new Date(doneAt.getTime() + 2 * DAY)),
        });
        expenseRows.push({
          id: uuid(),
          manager_user_id: managerUserId,
          property_id: p.prop,
          category_code: "plumbing",
          amount_cents: w.cost,
          expense_date: isoDate(new Date(doneAt.getTime() + 2 * DAY)),
          memo: `${w.title} · ${v.name}`,
          vendor_id: v.id,
          source_work_order_id: woId,
          source_vendor_invoice_id: invId,
          tax_deductible: true,
        });
      }
    } else if (w.jobPayout) {
      payoutRows.push({
        id: uuid(),
        manager_user_id: managerUserId,
        vendor_user_id: v.userId,
        work_order_id: woId,
        invoice_id: null,
        amount_cents: w.cost,
        status: "paid",
        stripe_transfer_id: `tr_showcase_${w.id}`,
        platform_fee_cents: 0,
        created_at: iso(new Date(doneAt.getTime() + 2 * DAY)),
        updated_at: iso(new Date(doneAt.getTime() + 2 * DAY)),
      });
      expenseRows.push({
        id: uuid(),
        manager_user_id: managerUserId,
        property_id: p.prop,
        category_code: "plumbing",
        amount_cents: w.cost,
        expense_date: isoDate(new Date(doneAt.getTime() + 2 * DAY)),
        memo: `${w.title} · ${v.name}`,
        vendor_id: v.id,
        source_work_order_id: woId,
        tax_deductible: true,
      });
    }
    if (w.review) {
      reviewRows.push({
        id: uuid(),
        manager_user_id: managerUserId,
        reviewer_user_id: managerUserId,
        vendor_user_id: v.userId,
        work_order_id: woId,
        stars: w.review.stars,
        body: w.review.body,
        vendor_reply: w.review.reply ?? null,
        vendor_replied_at: w.review.reply ? iso(new Date(doneAt.getTime() + 2 * DAY)) : null,
        created_at: iso(new Date(doneAt.getTime() + DAY)),
        updated_at: iso(new Date(doneAt.getTime() + DAY)),
      });
    }
  }
  await put("portal_work_order_records", "upsert", woRows, "id", "portal_work_order_records");
  await put("work_order_vendor_offers", "upsert", offerRows, "work_order_id,vendor_directory_id", "work_order_vendor_offers");
  await put("work_order_bids", "upsert", bidRows, "work_order_id,vendor_user_id", "work_order_bids");
  await put("vendor_invoices", "insert", invoiceRows, null);
  await put("vendor_payouts", "insert", payoutRows, null);
  await put("vendor_reviews", "insert", reviewRows, null);
  console.log(`  ${woRows.length} services, ${bidRows.length} quotes, ${invoiceRows.length} invoices, ${reviewRows.length} reviews`);

  /* ── Add-on service requests ── */
  const addOnOptions = [
    { id: "showcase-offer-parking", name: "Parking spot", description: "Reserved off-street parking", price: "$45 / month", deposit: "$0", available: true, billingCadence: "monthly", createdAt: iso(daysFromNow(-60)) },
    { id: "showcase-offer-storage", name: "Storage locker", description: "Basement storage locker", price: "$40 / month", deposit: "$50", available: true, billingCadence: "monthly", createdAt: iso(daysFromNow(-60)) },
  ];
  for (const prop of PROPERTIES) {
    const row = await must(supabase.from("manager_property_records").select("property_data").eq("id", prop.id).single(), `select ${prop.id}`);
    const data = row.property_data;
    data.listingSubmission = { ...data.listingSubmission, serviceRequestOptions: addOnOptions };
    await must(supabase.from("manager_property_records").update({ property_data: data }).eq("id", prop.id), `update ${prop.id}`);
  }
  const srRow = (id, who, offer, status, extra = {}) => {
    const p = person(who);
    const req = {
      id: `showcase-sr-${id}`,
      offerId: offer.id,
      offerName: offer.name,
      offerDescription: offer.description,
      price: offer.price,
      deposit: offer.deposit,
      residentEmail: p.email,
      residentName: p.name,
      managerUserId,
      propertyId: p.prop,
      returnByDate: "",
      notes: "",
      requestedAt: iso(daysFromNow(extra.daysAgo ?? -1)),
      status,
      servicePaid: false,
      depositPaid: status === "approved",
      ...extra.fields,
    };
    return { id: req.id, manager_user_id: managerUserId, resident_email: p.email, property_id: p.prop, status, row_data: req, updated_at: iso(NOW) };
  };
  await must(
    supabase.from("portal_service_request_records").upsert(
      [
        srRow("storage-liam", "liam", addOnOptions[1], "pending", { fields: { notes: "Locker near the mail room if possible." } }),
        srRow("parking-jamie", "jamie", addOnOptions[0], "approved", { daysAgo: -4, fields: { approvedAt: iso(daysFromNow(-2)) } }),
        srRow("storage-sam", "sam", addOnOptions[1], "denied", { daysAgo: -70, fields: { deniedAt: iso(daysFromNow(-68)) } }),
      ],
      { onConflict: "id" },
    ),
    "portal_service_request_records",
  );

  /* ── Tours + calendar + tasks + bookings ── */
  const inquiries = [];
  const planned = [];
  const mkTour = (id, name, email, phone, propKey, roomLabel, when, kind, extra = {}) => {
    const prop = propById.get(propKey);
    const start = when;
    const end = new Date(when.getTime() + 30 * 60_000);
    const base = {
      managerUserId,
      propertyId: prop.id,
      propertyTitle: prop.name,
      roomLabel,
      tourFormat: extra.virtual ? "virtual" : "in_person",
    };
    if (kind === "pending") {
      inquiries.push({
        id: `showcase-inq-${id}`,
        name,
        email,
        phone,
        notes: extra.notes ?? "Interested in the room and the lease length.",
        kind: "tour",
        status: "pending",
        ...base,
        proposedStart: slotIso(start),
        proposedEnd: slotIso(end),
        createdAt: iso(daysFromNow(-1)),
        tourGroupId: `showcase-grp-${id}`,
        requestedWindows: [{ start: slotIso(start), end: slotIso(end), slotKey: slotKeyFor(start), adminUserId: managerUserId }],
      });
    } else {
      inquiries.push({
        id: `showcase-inq-${id}`,
        name,
        email,
        phone,
        notes: "",
        kind: "tour",
        status: "accepted",
        ...base,
        proposedStart: slotIso(start),
        proposedEnd: slotIso(end),
        createdAt: iso(daysFromNow(-6)),
        tourGroupId: `showcase-grp-${id}`,
        requestedWindows: [{ start: slotIso(start), end: slotIso(end), slotKey: slotKeyFor(start), adminUserId: managerUserId }],
      });
      planned.push({
        id: `showcase-tour-${id}`,
        title: `Tour · ${name}`,
        start: slotIso(start),
        end: slotIso(end),
        kind: "tour",
        sourceInquiryId: `showcase-inq-${id}`,
        tourGroupId: `showcase-grp-${id}`,
        attendeeName: name,
        attendeeEmail: email,
        attendeePhone: phone,
        slotKey: slotKeyFor(start),
        adminUserId: managerUserId,
        adminLabel: MANAGER_NAME,
        ...base,
      });
    }
  };
  mkTour("morgan", "Morgan Ito", "morgan.ito@example.com", "(206) 555-0148", "showcase-alder", "Room 2", at(5, 11), "pending");
  mkTour("priyashah", "Priya Shah", "priya.shah@example.com", "(206) 555-0119", "showcase-maple", "Unit A", at(6, 16, 30), "pending", { virtual: true });
  mkTour("jamie", "Jamie P.", "jamie.p@example.com", "(206) 555-0131", "showcase-fremont", "Studio", at(3, 14), "upcoming");
  mkTour("noah", "Noah Kessler", "noah.kessler@example.com", "(206) 555-0163", "showcase-alder", "Room 3", at(3, 16), "upcoming");
  mkTour("zoe", "Zoe Patterson", "zoe.patterson@example.com", "(206) 555-0172", "showcase-maple", "Unit B", at(6, 10), "upcoming");
  mkTour("mina", "Mina Chen", "mina.chen@example.com", "(206) 555-0181", "showcase-maple", "Unit A", at(4, 11), "upcoming");
  mkTour("chris", "Chris Nakamura", "chris.n@example.com", "(206) 555-0107", "showcase-fremont", "Studio", at(-9, 13), "past");
  mkTour("jordan", "Resident", RESIDENT_EMAIL, "(206) 555-0186", "showcase-willow", "Room 3", at(-20, 17, 30), "past");

  // Service visits are also on the calendar via the work orders above. Tasks (and their calendar mirrors):
  const taskBase = { assignee: { type: "team", id: managerUserId, name: MANAGER_NAME }, completed: false, createdAt: iso(daysFromNow(-5)), updatedAt: iso(daysFromNow(-1)) };
  const tasks = [
    { ...taskBase, id: "showcase-task-countersign", title: "Countersign Dana Reyes's lease", taskType: "general", urgency: "scheduled", priority: "high", propertyId: "showcase-maple", propertyTitle: "Maple Duplex", start: iso(at(1, 9)), end: iso(at(1, 9, 30)) },
    { ...taskBase, id: "showcase-task-walk", title: "Walk-through at Alder House Room 3", taskType: "house", urgency: "scheduled", priority: "medium", propertyId: "showcase-alder", propertyTitle: "Alder House", start: iso(at(2, 13)), end: iso(at(2, 14)) },
    { ...taskBase, id: "showcase-task-insurance", title: "Renew landlord insurance", taskType: "general", urgency: "deadline", priority: "high", propertyId: "showcase-willow", propertyTitle: "Willow Court", dueDate: isoDate(daysFromNow(-3)) },
    { ...taskBase, id: "showcase-task-detectors", title: "Order smoke detectors for Fremont Studio", taskType: "general", urgency: "urgent", priority: "medium", propertyId: "showcase-fremont", propertyTitle: "Fremont Studio", assignee: undefined },
    { ...taskBase, id: "showcase-task-lockbox", title: "Rekey Willow Court lockbox", taskType: "house", urgency: "scheduled", priority: "low", propertyId: "showcase-willow", propertyTitle: "Willow Court", completed: true, completedAt: iso(daysFromNow(-2)) },
    { ...taskBase, id: "showcase-task-photos", title: "Photograph Maple Duplex Unit B for the listing", taskType: "house", urgency: "scheduled", priority: "medium", propertyId: "showcase-maple", propertyTitle: "Maple Duplex", completed: true, completedAt: iso(daysFromNow(-6)) },
  ];
  const taskEvents = tasks
    .filter((t) => t.start)
    .map((t) => ({
      id: `task_${t.id}`,
      title: t.title,
      start: t.start,
      end: t.end,
      kind: "task",
      sourceTaskId: t.id,
      managerUserId,
      adminUserId: managerUserId,
      propertyId: t.propertyId,
      propertyTitle: t.propertyTitle,
      assignee: t.assignee,
    }));
  const tasksId = `axis_manager_tasks_v1_${managerUserId}`;
  const blockRow = (key, propId, roomId, from, to, reason, who, rate, status) => {
    const id = `axis_room_block_${managerUserId}_showcase_${key}`;
    return {
      id,
      manager_user_id: managerUserId,
      property_id: propId,
      record_type: "room_date_block",
      starts_at: `${isoDate(daysFromNow(from))}T00:00:00`,
      ends_at: `${isoDate(daysFromNow(to))}T00:00:00`,
      row_data: {
        id,
        recordType: "room_date_block",
        propertyId: propId,
        roomId,
        checkIn: isoDate(daysFromNow(from)),
        checkOut: isoDate(daysFromNow(to)),
        reason,
        residentName: who,
        bookingStatus: status,
        rate,
        rateBasis: "daily",
        createdAt: iso(daysFromNow(-3)),
        managerUserId,
      },
      updated_at: iso(NOW),
    };
  };
  const slotKeys = [];
  for (let d = 0; d < 14; d++) {
    const day = at(d, 0);
    for (let slot = 18; slot < 34; slot++) slotKeys.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}:${slot}`);
  }
  const scheduleRows = [
    {
      id: tasksId,
      manager_user_id: managerUserId,
      property_id: null,
      record_type: "manager_tasks",
      row_data: { id: tasksId, recordType: "manager_tasks", managerUserId, tasks },
      updated_at: iso(NOW),
    },
    blockRow("fremont1", "showcase-fremont", "room-1", 8, 12, "Short stay", "Visiting nurse", 95, "confirmed"),
    blockRow("alder3", "showcase-alder", "room-3", 10, 17, "Short stay", "Corporate guest", 80, "hold"),
    ...PROPERTIES.map((prop) => {
      const id = `axis_mgr_avail_slots_v2_${managerUserId}_prop_${prop.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
      return {
        id,
        manager_user_id: managerUserId,
        property_id: prop.id,
        record_type: "manager_property_availability",
        row_data: { id, recordType: "manager_property_availability", managerUserId, propertyId: prop.id, payload: slotKeys },
        updated_at: iso(NOW),
      };
    }),
  ];
  await put("portal_schedule_records", "upsert", scheduleRows, "id", "portal_schedule_records(showcase)");
  await mergeSingleton("axis_admin_planned_events_v1", managerUserId, [...planned, ...taskEvents]);
  await mergeSingleton("axis_admin_partner_inquiries_v1", managerUserId, inquiries);
  // Register the manager as the tour host for each property.
  {
    const registryId = "axis_property_mgr_registry_v1";
    const existing = await must(supabase.from("portal_schedule_records").select("row_data").eq("id", registryId).maybeSingle(), "select registry");
    const current = existing?.row_data?.payload && typeof existing.row_data.payload === "object" ? { ...existing.row_data.payload } : {};
    for (const prop of PROPERTIES) {
      const hosts = (Array.isArray(current[prop.id]) ? current[prop.id] : []).filter((h) => h.userId !== managerUserId);
      hosts.push({ userId: managerUserId, label: MANAGER_NAME, propertyId: prop.id });
      current[prop.id] = hosts;
    }
    await must(
      supabase.from("portal_schedule_records").upsert(
        { id: registryId, manager_user_id: null, record_type: registryId, row_data: { id: registryId, recordType: registryId, payload: current }, updated_at: iso(NOW) },
        { onConflict: "id" },
      ),
      "portal_schedule_records(registry)",
    );
  }
  console.log(`  ${inquiries.length} tour records, ${tasks.length} tasks, 2 bookings`);

  /* ── Communication ── */
  const jordan = person("jordan");
  const thread = (idKey, scope, ownerUserId, counterpart, subject, messages, opts = {}) => {
    const id = `showcase-thread-${idKey}`;
    const last = messages[messages.length - 1];
    const first = messages[0];
    const row = {
      id,
      folder: opts.archived ? "trash" : "inbox",
      from: counterpart.name,
      email: counterpart.email,
      subject,
      preview: last.body,
      body: first.body,
      time: last.at,
      unread: Boolean(opts.unread),
      rootOutbound: Boolean(first.outbound),
      rootAt: first.at,
      rootChannel: first.channel,
      messages: messages.map((m, i) => ({ id: `${id}-m${i + 1}`, from: m.from, body: m.body, at: m.at, outbound: Boolean(m.outbound), channel: m.channel ?? "sms" })),
      scope,
      ...(opts.recordRef ? { recordRef: opts.recordRef } : {}),
    };
    return {
      id,
      scope,
      owner_user_id: ownerUserId,
      participant_email: counterpart.email.toLowerCase(),
      thread_type: "portal_message",
      row_data: row,
      updated_at: iso(NOW),
    };
  };
  const m = (from, body, when, outbound, channel) => ({ from, body, at: stamp(when), outbound, channel });
  const MGR = MANAGER_NAME;
  const managerThreads = [
    thread(
      "jordan",
      "axis_portal_inbox_manager_v1",
      managerUserId,
      { name: jordan.name, email: jordan.email },
      "Room 3 at Willow Court",
      [
        m(jordan.name, "Is room 3 at 61 Willow Court still available?", at(-24, 10, 12), false),
        m(MGR, "Yes, Room 3 is available from Oct 1 at $1,080/mo. I can offer a tour Thursday at 5:30 PM.", at(-24, 10, 20), true),
        m(jordan.name, "YES - Thursday at 5:30 PM works for me.", at(-24, 11, 2), false),
        m(MGR, "Your tour is confirmed for Thursday at 5:30 PM.", at(-24, 11, 5), true),
        m(jordan.name, "The kitchen faucet is dripping. Water is collecting under the cabinet.", at(-2, 9, 14), false),
        m(MGR, "A vendor is booked to look at the kitchen faucet on Thursday.", at(-1, 9, 40), true),
      ],
      { unread: true, recordRef: { kind: "resident", id: jordan.axisId, label: jordan.name } },
    ),
    thread(
      "mina",
      "axis_portal_inbox_manager_v1",
      managerUserId,
      { name: "Mina Chen", email: "mina.chen@example.com" },
      "Maple Duplex tour",
      [m("Mina Chen", "Could I tour Maple Duplex on Friday?", at(-1, 15, 4), false), m(MGR, "Friday at 11:00 AM is available.", at(-1, 15, 20), true)],
    ),
    thread(
      "pacific",
      "axis_portal_inbox_manager_v1",
      managerUserId,
      { name: "Pacific Plumbing", email: vendor.pacific.email },
      "Alder House: kitchen faucet drip",
      [
        m("Pacific Plumbing", "Running 20 min late for Alder House. Is there a gate code?", at(-1, 9, 48), false),
        m(MGR, "Gate code is 4471#. Liam confirmed he's home until noon.", at(-1, 9, 49), true),
        m("Pacific Plumbing", "The shut-off valve is corroded. The bid for the fix is $90. OK to proceed?", at(-1, 10, 30), false),
      ],
      { unread: true },
    ),
    thread(
      "jamie",
      "axis_portal_inbox_manager_v1",
      managerUserId,
      { name: "Jamie P.", email: "jamie.p@example.com" },
      "Fremont Studio",
      [
        m("Jamie P.", "Hi! Is the studio still available? Could I see it Saturday afternoon?", at(-3, 10, 2), false),
        m(MGR, "Yes, it's available from Oct 1 at $1,400/mo. Saturday works: 1:00, 2:00 or 3:30 PM.", at(-3, 10, 3), true),
        m("Jamie P.", "2:00 PM works great, thank you!", at(-3, 10, 5), false),
      ],
    ),
    thread(
      "liam",
      "axis_portal_inbox_manager_v1",
      managerUserId,
      { name: "Liam Foster", email: "liam.foster@example.com" },
      "Kitchen faucet",
      [
        m("Liam Foster", "Hi, the kitchen faucet has been dripping for two days. Can someone take a look?", at(-4, 8, 41), false, "email"),
        m(MGR, "Pacific Plumbing is booked for Thursday between 10 and 12.", at(-4, 8, 50), true, "email"),
      ],
    ),
    thread(
      "ethan",
      "axis_portal_inbox_manager_v1",
      managerUserId,
      { name: "Ethan Wright", email: "ethan.wright@example.com" },
      "Application fee",
      [m("Ethan Wright", "Thanks, just paid the application fee.", at(-6, 16, 12), false, "email")],
      { archived: true },
    ),
  ];
  const residentThreads = [
    thread(
      "res-avery",
      "axis_portal_inbox_resident_v1",
      jordan.userId,
      { name: MGR, email: "hello@seattlehomes.example" },
      "Willow Court",
      [
        m(jordan.name, "The kitchen faucet is dripping. Water is collecting under the cabinet.", at(-2, 9, 14), true),
        m(MGR, "A vendor is booked to look at the kitchen faucet on Thursday.", at(-1, 9, 40), false),
      ],
      { unread: true },
    ),
    thread(
      "res-rent",
      "axis_portal_inbox_resident_v1",
      jordan.userId,
      { name: "Willow Court", email: "hello@seattlehomes.example" },
      "Automated: rent",
      [m(MGR, `Rent of ${usd(jordan.rent)} is due soon. You can pay it from Payments.`, at(-1, 9, 0), false, "email")],
    ),
  ];
  const vendorThreads = [
    thread(
      "vend-avery",
      "axis_portal_inbox_vendor_v1",
      vendorUserId,
      { name: MGR, email: "hello@seattlehomes.example" },
      "Seattle Homes: Alder House",
      [
        m("Pacific Plumbing", "Running 20 min late for Alder House. Is there a gate code?", at(-1, 9, 48), true),
        m(MGR, "Gate code is 4471#. Liam confirmed he's home until noon.", at(-1, 9, 49), false),
        m("Pacific Plumbing", "The shut-off valve is corroded. The bid for the fix is $90. OK to proceed?", at(-1, 10, 30), true),
        m(MGR, "OK to proceed with the $90 change order.", at(-1, 10, 34), false),
      ],
      { unread: true },
    ),
    thread(
      "vend-invoice",
      "axis_portal_inbox_vendor_v1",
      vendorUserId,
      { name: MGR, email: "hello@seattlehomes.example" },
      "Seattle Homes: INV-1012",
      [m(MGR, "Paid. It will reach your bank in two business days.", at(-20, 16, 30), false, "email")],
    ),
    thread(
      "vend-old",
      "axis_portal_inbox_vendor_v1",
      vendorUserId,
      { name: MGR, email: "hello@seattlehomes.example" },
      "Seattle Homes: disposal",
      [m(MGR, "Thanks for the quick turnaround on the disposal.", at(-14, 17, 10), false, "email")],
      { archived: true },
    ),
  ];
  await put("portal_inbox_thread_records", "upsert", [...managerThreads, ...residentThreads, ...vendorThreads], "id", "portal_inbox_thread_records");
  console.log(`  ${managerThreads.length + residentThreads.length + vendorThreads.length} inbox threads`);

  /* ── Forms ── */
  const q = (key, label, type = "text", required = true) => ({ id: `q-${key}`, key, label, type, required, options: [] });
  const formRow = (idKey, who, name, status, questions, extra = {}) => {
    const p = person(who);
    return {
      application_id: p.axisId,
      manager_user_id: managerUserId,
      property_id: p.prop,
      property_label: p.propData.name,
      room_label: p.roomData.name,
      resident_name: p.name,
      resident_email: p.email,
      resident_user_id: p.userId ?? null,
      form_id: `mif-showcase-${idKey}`,
      form_name: name,
      source: "built",
      snapshot: { questions, pdf: null, kind: "other", blocks: "nothing" },
      status,
      answers: [],
      sent_at: iso(daysFromNow(-3)),
      due_at: iso(daysFromNow(4)),
      ...extra,
    };
  };
  const formRows = [
    formRow("jordan-movein", "jordan", "Move-in details", "sent", [q("arrival_time", "Expected arrival time"), q("vehicle", "Do you have a vehicle?", "yes_no"), q("emergency_contact", "Emergency contact name")], { due_at: iso(daysFromNow(1)) }),
    formRow("jordan-insurance", "jordan", "Renters insurance proof", "sent", [q("provider", "Insurance provider"), q("policy", "Policy number")], { due_at: iso(daysFromNow(14)) }),
    formRow("jordan-rules", "jordan", "House rules acknowledgment", "submitted", [q("agree", "I have read the house rules", "yes_no")], {
      answers: [{ key: "agree", value: true }],
      submitted_at: iso(daysFromNow(-2)),
      manager_viewed_at: iso(daysFromNow(-1)),
    }),
    formRow("dana-movein", "dana", "Move-in details", "sent", [q("arrival_time", "Expected arrival time"), q("vehicle", "Do you have a vehicle?", "yes_no")], { due_at: iso(daysFromNow(2)) }),
    formRow("liam-parking", "liam", "Parking agreement", "sent", [q("plate", "License plate"), q("vehicle", "Vehicle make and model")], { sent_at: iso(daysFromNow(-8)), due_at: iso(daysFromNow(-2)) }),
    formRow("priya-keys", "priya", "Key receipt", "submitted", [q("keys", "Number of keys received", "text")], {
      answers: [{ key: "keys", value: "2" }],
      submitted_at: iso(daysFromNow(-5)),
      manager_viewed_at: null,
    }),
    formRow("tomas-pet", "tomas", "Pet agreement", "submitted", [q("pet_name", "Pet name"), q("vaccinated", "Vaccinated?", "yes_no")], {
      answers: [{ key: "pet_name", value: "Biscuit" }, { key: "vaccinated", value: true }],
      submitted_at: iso(daysFromNow(-9)),
      manager_viewed_at: iso(daysFromNow(-8)),
    }),
  ];
  await put("resident_move_in_forms", "insert", formRows, null);
  console.log(`  ${formRows.length} forms`);

  /* ── Money: ledger, deposits, expenses, payees ── */
  const chargeRowsNow = await must(
    supabase.from("portal_household_charge_records").select("id,row_data,status").eq("manager_user_id", managerUserId),
    "select charges",
  );
  const ledgerRows = [];
  const depositRows = [];
  for (const c of chargeRowsNow) {
    const d = c.row_data;
    if (d.status !== "paid") continue;
    const amount = Math.round(Number(String(d.amountLabel).replace(/[$,]/g, "")) * 100);
    const paidDate = isoDate(new Date(d.paidAt ?? NOW));
    ledgerRows.push({
      manager_user_id: managerUserId,
      resident_user_id: d.residentUserId ?? null,
      resident_email: d.residentEmail,
      property_id: d.propertyId,
      unit_label: person(PEOPLE.find((p) => p.email === d.residentEmail)?.key ?? "jordan").roomData.name,
      lease_id: d.applicationId ?? null,
      entry_type: "payment",
      category_code: d.kind === "rent" || d.kind === "first_month_rent" ? "rent_income" : d.kind === "application_fee" ? "application_fee" : "other_income",
      amount_cents: amount,
      due_date: paidDate,
      posted_date: paidDate,
      source_charge_id: d.id,
      description: d.title,
    });
    if (d.kind === "security_deposit") {
      depositRows.push({
        manager_user_id: managerUserId,
        source_charge_id: d.id,
        property_id: d.propertyId,
        unit_label: "Room 3",
        lease_id: d.applicationId,
        resident_user_id: d.residentUserId ?? null,
        resident_email: d.residentEmail,
        amount_cents: amount,
        amount_held_cents: amount,
        received_date: paidDate,
        status: "held",
        itemization: [],
      });
    }
  }
  if (ledgerRows.length) await put("ledger_entries", "insert", ledgerRows, null);
  if (depositRows.length) await put("security_deposit_ledger", "insert", depositRows, null);

  const payee = await must(
    supabase
      .from("manager_payees")
      .insert({ manager_user_id: managerUserId, kind: "other", payee_type: "mortgage", name: "Puget Sound Home Lending", account_reference: "4821", pay_method: "bank_transfer" })
      .select("id")
      .single(),
    "manager_payees",
  );
  const exp = (monthsBack, day, prop, code, dollars, memo, extra = {}) => {
    const dt = new Date(NOW.getFullYear(), NOW.getMonth() - monthsBack, day);
    if (dt > NOW) return null;
    return { id: uuid(), manager_user_id: managerUserId, property_id: prop, category_code: code, amount_cents: cents(dollars), expense_date: isoDate(dt), memo, tax_deductible: true, ...extra };
  };
  for (let mb = 0; mb < 4; mb++) {
    for (const row of [
      exp(mb, 1, "showcase-willow", "mortgage", 2450, "Mortgage payment", { payee_id: payee.id }),
      exp(mb, 5, "showcase-alder", "utilities", 168 + mb * 7, "Seattle City Light"),
      exp(mb, 6, "showcase-maple", "utilities", 142 + mb * 5, "Seattle Public Utilities"),
      exp(mb, 8, "showcase-fremont", "wifi", 70, "Fiber internet"),
      exp(mb, 12, "showcase-willow", "cleaning", 120, "Common-area cleaning"),
    ]) {
      if (row) expenseRows.push(row);
    }
  }
  expenseRows.push(exp(2, 15, "showcase-maple", "insurance", 640, "Landlord insurance, quarterly"), exp(1, 20, "showcase-alder", "property_tax", 1880, "Property tax installment"));
  await put("manager_expense_entries", "insert", expenseRows.filter(Boolean), null);
  console.log(`  ${ledgerRows.length} ledger payments, ${expenseRows.filter(Boolean).length} expenses`);

  /* ── Documents ── */
  const docRows = [];
  const docDefs = [
    { name: "Landlord insurance certificate", cat: "insurance", prop: "showcase-willow", vis: "manager", lines: ["Seattle Homes LLC", "Policy EM-448120"] },
    { name: "Willow Court house rules", cat: "notice", prop: "showcase-willow", vis: "resident", who: "jordan", lines: ["Quiet hours 10pm-8am", "No smoking"] },
    { name: "Move-in checklist", cat: "inspection", prop: "showcase-willow", vis: "resident", who: "jordan", lines: ["Room 3 move-in checklist"] },
    { name: "Pacific Plumbing service agreement", cat: "other", prop: null, vis: "vendor", vendor: vendor.pacific.id, lines: ["Master service agreement", "Pacific Plumbing and Seattle Homes"] },
    { name: "Alder House W-9", cat: "tax", prop: "showcase-alder", vis: "manager", lines: ["Owner W-9 (sample)"] },
  ];
  for (const d of docDefs) {
    const objectPath = `manager/${managerUserId}/showcase-${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`;
    const size = await uploadPdf("manager-documents", objectPath, d.name, d.lines);
    if (size == null) continue;
    const who = d.who ? person(d.who) : null;
    docRows.push({
      manager_user_id: managerUserId,
      display_name: d.name,
      original_filename: `${d.name}.pdf`,
      mime_type: "application/pdf",
      size_bytes: size,
      storage_path: objectPath,
      category: d.cat,
      property_id: d.prop,
      visibility: d.vis,
      resident_email: who?.email ?? null,
      resident_user_id: who?.userId ?? null,
      vendor_id: d.vendor ?? null,
      uploaded_by: managerUserId,
    });
  }
  if (docRows.length) await put("manager_documents", "insert", docRows, null);
  console.log(`  ${docRows.length} documents`);

  /* ── Promotion (built by the app's own default-asset builder) ── */
  const promo = spawnSync("npx", ["--yes", "tsx", path.join(projectRoot, "tests/helpers/seed-manager-promotion-defaults.ts")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SEED_MANAGER_USER_ID: managerUserId,
      SEED_MANAGER_EMAIL: MANAGER_EMAIL,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=react-server`.trim(),
    },
    stdio: "inherit",
  });
  if (promo.status !== 0) console.warn(`  (promotion defaults failed, exit ${promo.status})`);

  void workspaceId;
  void mgrPerson;
  void rooms;
}

main().catch((err) => {
  console.error(`Stopped at: ${lastStep}`);
  console.error(err);
  process.exit(1);
});

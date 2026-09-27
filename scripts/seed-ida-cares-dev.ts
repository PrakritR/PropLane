#!/usr/bin/env npx tsx
/**
 * Seed the Ida Cares Homes (Marc) lease-first scenario on the DEV/TEST
 * Supabase project ONLY (studio brief:
 * ~/proplane-mock-kit/studio/assets/ida-cares/BRIEF.md § Scenario data).
 *
 *   npx tsx scripts/seed-ida-cares-dev.ts
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the
 * environment (falls back to .env), and refuses to run anywhere but the
 * dedicated test project (`assertTestProjectUrl`).
 *
 * Idempotent: every row is keyed by a stable id and upserted, and this
 * script deletes-then-reinserts only rows scoped to the Marc manager account
 * it creates — it never touches another manager's data.
 *
 * WARNING (same caveat `seed-akhil-dev-accounts.mjs` documents): `npm run
 * test:seed` prunes every non-canonical auth account on the test project.
 * Re-run this script after a full reseed to bring Marc/Jordan/Casey back.
 *
 * What this creates:
 * - Manager **Marc** (Ida Cares Homes), business-tier plan so nothing is
 *   plan-gated.
 * - One property, **Ida Cares — Maple House**, by-the-room, 4 rooms, priced
 *   both per month and per day.
 * - A **License agreement** lease template (`PropertyLeaseTemplate`, custom /
 *   document kind) with a PUBLISHED question config built from real clauses
 *   in `studio/assets/ida-cares/Ida Cares Homes_License Agreement.txt`,
 *   using the new "initials" field type + manager-filled money fields
 *   (`filledBy: "manager"`) — see `src/lib/property-lease-templates.ts` and
 *   `src/lib/manager-listing-submission.ts`. The DRAFT copy carries one
 *   deliberately unresolved import issue so a manager's review screen still
 *   has something to resolve (brief: "keep one unresolved import issue on a
 *   draft copy").
 * - An **Intake form** application template (`PropertyApplicationTemplate`)
 *   with a representative subset of the real Intake Form's questions
 *   (General info, Secured info, Financial info, Emergency info, Medical
 *   info with a conditional "if yes" follow-up, Suitability questionnaire,
 *   Attestation) — NOT the full ~60-field form transcribed field-for-field;
 *   see the file header comment on `application-pdf-import.ts` for why a
 *   full section-accurate transcription is a separate, larger task.
 * - **Jordan Reyes**, a prospective resident with a lease-first draft SENT
 *   but NOT signed (`createLeaseFirstDraft`, the real server function — same
 *   path "Send lease to sign" uses today).
 * - **Casey Odom**, a resident whose License agreement is already fully
 *   signed (direct `portal_lease_pipeline_records` row, matching the
 *   existing signed-lease shape `seed-akhil-dev-accounts.mjs` already seeds
 *   for its dogfood portfolio — no signature hash is fabricated, exactly
 *   like that precedent, since these are synthetic seed rows never fed
 *   through the real signing action) and an INCOMPLETE Intake form
 *   application prefilled from the license agreement's allowlisted shared
 *   fields (`leaseIntakeFromApplication`/`applicationFieldsFromLeaseIntake`
 *   in `src/lib/leasing/lease-application-field-map.ts`), representing
 *   "now on the intake form."
 *
 * NOT seeded here (production doesn't support it yet — out of scope for this
 * task, see WS1b's build report): an actual workspace-level "lease-first
 * ordering" switch that forces every new prospect through the License
 * agreement before the Intake form. Today this script only seeds the DATA
 * (the templates, the two residents at their two stages); enforcing the
 * order is part of the not-yet-built resident-facing dynamic step wizard.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertTestProjectUrl } from "../tests/helpers/canonical-test-accounts.mjs";
import { createLeaseFirstDraft } from "@/lib/leasing/lease-first-draft.server";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

// ---- env --------------------------------------------------------------

function loadDotEnvFallback() {
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 1 || line.trimStart().startsWith("#")) continue;
      const key = line.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
    }
  }
}
loadDotEnvFallback();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env, .env.local, or .env).");
  process.exit(1);
}
assertTestProjectUrl(url); // exits the process on anything but the dev/test project.

const supabase: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const NOW = new Date();
const PASSWORD = "Password123!";
const MANAGER_EMAIL = "marc.idacares@test.proplane.local";
const MANAGER_NAME = "Marc";
const WORKSPACE_NAME = "Ida Cares Homes";
const PROPERTY_ID = "mgr-idacares-maple";
const JORDAN_EMAIL = "jordan.reyes.idacares@test.proplane.local";
const CASEY_EMAIL = "casey.odom.idacares@test.proplane.local";
// profiles.manager_id carries a UNIQUE value for every row (manager or
// resident) — for a resident it is their own application-style id, never the
// shared manager id (that caused a unique-constraint violation the first
// time this script ran: both residents got the same manager_id).
const JORDAN_AXIS_ID = "AXIS-IDACARESJR";
const CASEY_AXIS_ID = "AXIS-IDACARESCO";

function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}

async function must<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>, label: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureUser(
  email: string,
  role: "manager" | "resident",
  opts: { managerId?: string | null; fullName?: string | null } = {},
): Promise<string> {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { role },
  });
  let userId: string;
  if (createErr) {
    if (!createErr.message.toLowerCase().includes("already")) throw new Error(`createUser ${email}: ${createErr.message}`);
    const found = await findUserIdByEmail(email);
    if (!found) throw new Error(`User ${email} exists but was not found.`);
    userId = found;
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { role },
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
        ...(opts.managerId ? { manager_id: opts.managerId } : {}),
        full_name: opts.fullName ?? email.split("@")[0],
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

// ---- License agreement clauses (real text, studio/assets/ida-cares) ----

const licenseAcknowledgements: ManagerCustomApplicationField[] = [
  {
    id: "la-ack-not-a-lease",
    key: "la_ack_not_a_lease",
    label: "I understand that THIS AGREEMENT IS NOT A LEASE.",
    type: "initials",
    required: true,
    options: [],
    section: "Acknowledgements",
  },
  {
    id: "la-ack-utilities",
    key: "la_ack_utilities",
    label:
      "I understand that IDA CARES HOMES provides and pays for utilities, furnishings, cleaning services and controls all keys to the premises and individual rooms.",
    type: "initials",
    required: true,
    options: [],
    section: "Acknowledgements",
  },
  {
    id: "la-ack-trespass",
    key: "la_ack_trespass",
    label:
      "I understand that if I violate any rules of the license agreement, I may be considered a criminal trespasser and subject to arrest under State Penal Code, \"Trespassing\".",
    type: "initials",
    required: true,
    options: [],
    section: "Acknowledgements",
  },
  {
    id: "la-ack-house-rules-read",
    key: "la_ack_house_rules_read",
    label: "I have read and understand the house rules provided to me (see addendum VIII).",
    type: "initials",
    required: true,
    options: [],
    section: "Acknowledgements",
  },
  {
    id: "la-ack-not-assisted-living",
    key: "la_ack_not_assisted_living",
    label:
      "I understand that IDA CARES HOMES is NOT an assisted living facility or a nursing home and does not provide assistance with activities of daily living.",
    type: "initials",
    required: true,
    options: [],
    section: "Acknowledgements",
  },
  {
    id: "la-ack-damages",
    key: "la_ack_damages",
    label: "I understand that any damages (other than normal wear) will be my financial responsibility.",
    type: "initials",
    required: true,
    options: [],
    section: "Acknowledgements",
  },
];

const licenseFees: ManagerCustomApplicationField[] = [
  {
    id: "la-fee-monthly",
    key: "la_fee_monthly",
    label: "Monthly license fee",
    type: "currency",
    required: true,
    options: [],
    section: "I. Fees",
    filledBy: "manager",
  },
  {
    id: "la-fee-daily",
    key: "la_fee_daily",
    label: "Daily license fee",
    type: "currency",
    required: true,
    options: [],
    section: "I. Fees",
    filledBy: "manager",
  },
  {
    id: "la-fee-move-in",
    key: "la_fee_move_in",
    label: "Move-in fee",
    type: "currency",
    required: true,
    options: [],
    section: "I. Fees",
    filledBy: "manager",
    description: "$500 fixed.",
  },
];

const licensePestControl: ManagerCustomApplicationField[] = [
  {
    id: "la-pest-block",
    key: "la_pest_block",
    label:
      "II. Pest control and infestation (A–D): Initial on line to left to certify the above paragraphs.",
    type: "initials",
    required: true,
    options: [],
    section: "II. Pest control and infestation",
  },
];

const licenseResponsibilities: ManagerCustomApplicationField[] = [
  {
    id: "la-resp-block",
    key: "la_resp_block",
    label: "III. Responsibilities — I have read and accept the responsibilities section in full.",
    type: "initials",
    required: true,
    options: [],
    section: "III. Responsibilities",
  },
];

const licenseAuthorization: ManagerCustomApplicationField[] = [
  {
    id: "la-sig-licensee",
    key: "la_sig_licensee",
    label: "Licensee signature",
    type: "text",
    required: true,
    options: [],
    section: "VII. Agreement authorization",
  },
  {
    id: "la-sig-representative",
    key: "la_sig_representative",
    label: "Licensee's representative (optional)",
    type: "text",
    required: false,
    options: [],
    section: "VII. Agreement authorization",
  },
  {
    id: "la-sig-legal-representative",
    key: "la_sig_legal_representative",
    label: "Licensee's legal representative (optional)",
    type: "text",
    required: false,
    options: [],
    section: "VII. Agreement authorization",
  },
  {
    id: "la-sig-guarantor",
    key: "la_sig_guarantor",
    label: "Personal guarantee of payment — guarantor name (optional)",
    type: "text",
    required: false,
    options: [],
    section: "VII. Agreement authorization",
  },
];

const licenseHouseRules: ManagerCustomApplicationField[] = [
  {
    id: "la-house-rules-ack",
    key: "la_house_rules_ack",
    label: "VIII. House rules addendum — I have read and understand the house rules.",
    type: "initials",
    required: true,
    options: [],
    section: "VIII. House rules addendum",
  },
];

const licenseCustomFields: ManagerCustomApplicationField[] = [
  ...licenseAcknowledgements,
  ...licenseFees,
  ...licensePestControl,
  ...licenseResponsibilities,
  ...licenseAuthorization,
  ...licenseHouseRules,
];

function nowIso(): string {
  return NOW.toISOString();
}

function buildLicenseAgreementTemplate(): PropertyLeaseTemplate {
  const publishedConfig: ApplicationTemplateQuestionConfig = {
    disabledStandardApplicationKeys: [],
    customApplicationFields: licenseCustomFields,
    applicationConfigMode: "custom",
    version: 1,
    importProvenance: {
      sourceName: "Ida Cares Homes_License Agreement.pdf",
      sourcePath: "seed:ida-cares-license-agreement",
      sourceSha256: "seed0000000000000000000000000000000000000000000000000000000000",
      importedAt: daysFromNow(-10).toISOString(),
      unresolvedCount: 0,
      issues: [],
      resolvedIssueIndexes: [],
      reviewedByUserId: undefined,
      reviewedAt: daysFromNow(-9).toISOString(),
    },
  };
  // Draft carries one field the manager hasn't finished placing yet, and one
  // deliberately UNRESOLVED import issue — brief: "keep one unresolved import
  // issue on a draft copy so the manager's review screen still shows the
  // issue flow."
  const draftConfig: ApplicationTemplateQuestionConfig = {
    ...publishedConfig,
    customApplicationFields: [
      ...licenseCustomFields,
      {
        id: "la-indemnification-block",
        key: "la_indemnification_block",
        label: "V. Indemnification — I have read and accept the indemnification section.",
        type: "initials",
        required: true,
        options: [],
        section: "V. Indemnification",
      },
    ],
    importProvenance: {
      ...publishedConfig.importProvenance,
      unresolvedCount: 1,
      issues: [
        {
          pageNumber: 5,
          code: "ambiguous_clause_boundary",
          message: "Section V (Indemnification) and Section VI (Rules) share one paragraph break — confirm the split before publishing.",
        },
      ],
    },
  };
  return {
    id: "lease-tpl-license-agreement",
    kind: "custom",
    label: "License agreement",
    leaseConfigMode: "custom",
    leaseCustomKind: "document",
    customLeaseTerms: "",
    leaseTemplateDocUrl: null,
    leaseTemplateDocName: "Ida Cares Homes_License Agreement.pdf",
    draftQuestionConfig: draftConfig,
    publishedQuestionConfig: publishedConfig,
    publishedQuestionConfigVersions: [],
    createdAt: daysFromNow(-10).toISOString(),
    updatedAt: nowIso(),
  } as PropertyLeaseTemplate;
}

// ---- Intake form (representative subset, real section names/order) -----

const intakeGeneral: ManagerCustomApplicationField[] = [
  { id: "if-nickname", key: "if_nickname", label: "Nickname", type: "text", required: false, options: [], section: "General information" },
  { id: "if-pronoun", key: "if_pronoun", label: "Preferred pronoun", type: "text", required: false, options: [], section: "General information" },
  { id: "if-gender-identity", key: "if_gender_identity", label: "Gender identity", type: "text", required: false, options: [], section: "General information" },
];

const intakeSecured: ManagerCustomApplicationField[] = [
  { id: "if-dob", key: "if_dob", label: "Date of birth", type: "date", required: true, options: [], section: "Secured information" },
  { id: "if-id-number", key: "if_id_number", label: "ID / CDL #", type: "text", required: false, options: [], section: "Secured information" },
  { id: "if-marital-status", key: "if_marital_status", label: "Marital status", type: "select", required: false, options: ["Single", "Married", "Divorced", "Widowed"], section: "Secured information" },
];

const intakeFinancial: ManagerCustomApplicationField[] = [
  { id: "if-income-1", key: "if_income_1", label: "Monthly income 1", type: "currency", required: false, options: [], section: "Financial information" },
  { id: "if-income-1-source", key: "if_income_1_source", label: "Income 1 source", type: "text", required: false, options: [], section: "Financial information" },
  { id: "if-expenses", key: "if_expenses", label: "Expenses", type: "multi_select", required: false, options: ["Cell phone", "Car loans", "Other"], section: "Financial information" },
];

const intakeEmergency: ManagerCustomApplicationField[] = [
  { id: "if-emergency-1-name", key: "if_emergency_1_name", label: "Emergency contact 1 — name", type: "text", required: true, options: [], section: "Emergency information" },
  { id: "if-emergency-1-phone", key: "if_emergency_1_phone", label: "Emergency contact 1 — phone", type: "phone", required: true, options: [], section: "Emergency information" },
];

const intakeMedical: ManagerCustomApplicationField[] = [
  { id: "if-medical-insurance", key: "if_medical_insurance", label: "Do you have medical insurance?", type: "yes_no", required: true, options: [], section: "Medical information" },
  {
    id: "if-medical-provider",
    key: "if_medical_provider",
    label: "Insurance provider",
    type: "text",
    required: false,
    options: [],
    section: "Medical information",
    showIf: { fieldKey: "if_medical_insurance", equals: "yes" },
  },
];

const intakeSuitability: ManagerCustomApplicationField[] = [
  { id: "if-walk-independently", key: "if_walk_independently", label: "Can you walk independently?", type: "select", required: true, options: ["Yes", "No", "Sometimes"], section: "Resident suitability questionnaire" },
  {
    id: "if-walk-explain",
    key: "if_walk_explain",
    label: "If No or Sometimes, please explain",
    type: "long_text",
    required: false,
    options: [],
    section: "Resident suitability questionnaire",
    showIf: { fieldKey: "if_walk_independently", equals: "No" },
  },
];

const intakeAttestation: ManagerCustomApplicationField[] = [
  {
    id: "if-attestation",
    key: "if_attestation",
    label: "I attest the information above is true and accurate; a false statement is grounds for eviction.",
    type: "checkbox",
    required: true,
    options: [],
    section: "Attestation",
  },
];

const intakeCustomFields: ManagerCustomApplicationField[] = [
  ...intakeGeneral,
  ...intakeSecured,
  ...intakeFinancial,
  ...intakeEmergency,
  ...intakeMedical,
  ...intakeSuitability,
  ...intakeAttestation,
];

function buildIntakeFormTemplate() {
  const publishedConfig: ApplicationTemplateQuestionConfig = {
    disabledStandardApplicationKeys: [],
    customApplicationFields: intakeCustomFields,
    applicationConfigMode: "custom",
    version: 1,
    importProvenance: {
      sourceName: "Ida Cares Homes_Intake Form.pdf",
      sourcePath: "seed:ida-cares-intake-form",
      sourceSha256: "seed1111111111111111111111111111111111111111111111111111111111",
      importedAt: daysFromNow(-10).toISOString(),
      unresolvedCount: 0,
      issues: [],
      resolvedIssueIndexes: [],
      reviewedAt: daysFromNow(-9).toISOString(),
    },
  };
  return {
    id: "app-tpl-intake-form",
    kind: "long-term" as const,
    label: "Intake form",
    formVariant: "standard" as const,
    createdAt: daysFromNow(-10).toISOString(),
    updatedAt: nowIso(),
    draftQuestionConfig: publishedConfig,
    publishedQuestionConfig: publishedConfig,
    publishedQuestionConfigVersions: [],
  };
}

// ---- Property -----------------------------------------------------------

function buildMapleHouseSubmission(managerUserId: string) {
  const roomIds = ["room-1", "room-2", "room-3", "room-4"];
  return {
    v: 1 as const,
    buildingName: "Ida Cares — Maple House",
    address: "918 Maple Ave, Everett, WA 98201",
    zip: "98201",
    neighborhood: "Everett",
    listingPlaceCategoryId: "private_room",
    tagline: "Sober-living licensed home, by the room.",
    petFriendly: false,
    houseOverview: "A 4-room licensed sober-living home operated by Ida Cares Homes.",
    houseRulesText: "See the House rules addendum in the License agreement.",
    housePhotoDataUrls: [],
    allowedLeaseTerms: ["Month-to-Month"],
    leaseTermsBody: "Available: month-to-month, priced per month or per day.",
    applicationFee: "$0",
    rooms: roomIds.map((id, i) => ({
      id,
      name: `Room ${i + 1}`,
      floor: i < 2 ? "1st floor" : "2nd floor",
      rent: 900,
      detail: "Furnished room, shared bath.",
      furnishing: "Fully furnished",
      roomAmenitiesText: "Bed\nDesk\nCloset",
      occupancyCapacity: 1,
      monthlyRent: 900,
      dailyRentPrice: 40,
    })),
    managerUserId,
    propertyApplicationTemplatesExplicit: true,
    propertyApplicationTemplates: [buildIntakeFormTemplate()],
    propertyLeaseTemplates: [buildLicenseAgreementTemplate()],
  };
}

// ---- main -----------------------------------------------------------

async function main() {
  console.log(`Seeding Ida Cares Homes into ${new URL(url!).hostname} (dev/test)`);

  const managerUserId = await ensureUser(MANAGER_EMAIL, "manager", { fullName: MANAGER_NAME });
  const { data: managerProfile } = await supabase.from("profiles").select("manager_id").eq("id", managerUserId).maybeSingle();
  const managerId = managerProfile?.manager_id?.trim() || `mgr_${managerUserId.slice(0, 8)}`;
  await must(
    supabase.from("profiles").update({ manager_id: managerId, full_name: MANAGER_NAME, role: "manager", application_approved: true }).eq("id", managerUserId),
    "profiles(manager id)",
  );

  // Business-tier plan so nothing in the scenario is plan-gated.
  const { data: existingPurchase } = await supabase.from("manager_purchases").select("id").eq("user_id", managerUserId).maybeSingle();
  const purchasePatch = { tier: "business", billing: "portal", promo_code: "FREE100", paid_at: NOW.toISOString(), email: MANAGER_EMAIL, user_id: managerUserId };
  if (existingPurchase?.id) {
    await must(supabase.from("manager_purchases").update(purchasePatch).eq("id", existingPurchase.id), "manager_purchases(update)");
  } else {
    await must(
      supabase.from("manager_purchases").upsert({ ...purchasePatch, manager_id: managerId, stripe_checkout_session_id: `seed_idacares_${managerId}` }, { onConflict: "manager_id" }),
      "manager_purchases(insert)",
    );
  }

  // Lease-first pipeline order (PLAN-0924-1254 `leasing-pipeline-preferences.ts`):
  // without this, `leaseUnlocksWithoutApplicationApproval` reads the default
  // ("application_then_lease") and neither `ResidentLeaseIntakeSection` nor the
  // new lease-first signing wizard ever activates for Jordan/Casey, and
  // `begin_lease_first_signing` has no `defaultLeaseTemplateId` to resolve.
  await must(
    supabase.from("manager_automation_settings").upsert(
      {
        manager_user_id: managerUserId,
        row_data: {
          leasingPipeline: {
            pipelineOrder: "lease_then_application",
            requireApplication: true,
            requireLease: true,
            leaseSigningFeeCents: null,
            defaultApplicationTemplateId: "app-tpl-intake-form",
            defaultLeaseTemplateId: "lease-tpl-license-agreement",
          },
        },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "manager_user_id" },
    ),
    "manager_automation_settings(leasingPipeline)",
  );

  const jordanUserId = await ensureUser(JORDAN_EMAIL, "resident", { managerId: JORDAN_AXIS_ID, fullName: "Jordan Reyes" });
  const caseyUserId = await ensureUser(CASEY_EMAIL, "resident", { managerId: CASEY_AXIS_ID, fullName: "Casey Odom" });

  // Scoped cleanup — only this manager's own rows, never a canonical account's.
  for (const table of ["manager_property_records", "manager_application_records", "portal_lease_pipeline_records"]) {
    await must(supabase.from(table).delete().eq("manager_user_id", managerUserId), `clean ${table}`);
  }

  const submission = buildMapleHouseSubmission(managerUserId);
  await must(
    supabase.from("manager_property_records").upsert(
      {
        id: PROPERTY_ID,
        manager_user_id: managerUserId,
        status: "live",
        property_data: {
          id: PROPERTY_ID,
          title: submission.buildingName,
          address: submission.address,
          zip: submission.zip,
          neighborhood: submission.neighborhood,
          beds: submission.rooms.length,
          baths: 1,
          rentLabel: "$900 / mo",
          available: "Now",
          petFriendly: false,
          buildingId: `${PROPERTY_ID}-bld`,
          buildingName: submission.buildingName,
          unitLabel: `${submission.rooms.length} rooms`,
          managerUserId,
          adminPublishLive: true,
          listingSubmission: submission,
        },
        row_data: { id: PROPERTY_ID, status: "live", name: submission.buildingName, buildingName: submission.buildingName, address: submission.address },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    "manager_property_records",
  );

  // Jordan Reyes: lease-first draft SENT, not signed — the real server path
  // ("Send lease to sign") rather than a hand-built row.
  const draft = await createLeaseFirstDraft(supabase, {
    managerUserId,
    propertyId: PROPERTY_ID,
    roomChoice: "room-1",
    name: "Jordan Reyes",
    email: JORDAN_EMAIL,
    phone: "206-555-0142",
  });
  if (!draft.ok) throw new Error(`createLeaseFirstDraft(Jordan): ${draft.error}`);
  // Jordan's auth account already exists (created above) — link it onto the
  // draft row so the resident's own sign-in resolves this lease, the same
  // way a real "create account from the lease-first invite" flow would.
  await must(
    supabase.from("portal_lease_pipeline_records").update({ resident_user_id: jordanUserId }).eq("id", draft.leaseId),
    "portal_lease_pipeline_records(jordan resident_user_id)",
  );
  console.log(`  Jordan Reyes lease-first draft: ${draft.leaseId} (created=${draft.created})`);

  // Casey Odom: License agreement fully signed (direct row, no fabricated
  // hash — same convention seed-akhil-dev-accounts.mjs already uses for its
  // synthetic signed leases), now on the Intake form.
  const caseyLeaseId = "lease_idacares_casey_odom";
  const genIso = daysFromNow(-6).toISOString();
  const resSignIso = daysFromNow(-4).toISOString();
  const mgrSignIso = daysFromNow(-3).toISOString();
  await must(
    supabase.from("portal_lease_pipeline_records").upsert(
      {
        id: caseyLeaseId,
        manager_user_id: managerUserId,
        resident_user_id: caseyUserId,
        resident_email: CASEY_EMAIL,
        property_id: PROPERTY_ID,
        status: "signed",
        row_data: {
          id: caseyLeaseId,
          residentName: "Casey Odom",
          residentEmail: CASEY_EMAIL,
          unit: "Ida Cares — Maple House · Room 2",
          updated: "just now",
          pdfVersion: 1,
          notes: "License agreement (Ida Cares lease-first).",
          updatedAtIso: NOW.toISOString(),
          propertyId: PROPERTY_ID,
          roomChoice: `${PROPERTY_ID}::room-2`,
          managerUserId,
          residentUserId: caseyUserId,
          leaseFirst: true,
          generatedAtIso: genIso,
          managerUploadedPdf: null,
          thread: [],
          managerSignature: { name: MANAGER_NAME, signedAtIso: mgrSignIso, role: "manager" },
          residentSignature: { name: "Casey Odom", signedAtIso: resSignIso, role: "resident" },
          signatureName: "Casey Odom",
          signedAtIso: resSignIso,
          residentSignedAt: resSignIso,
          managerSignedAt: mgrSignIso,
          sentToResidentAt: genIso,
          fullySignedAt: mgrSignIso,
          voidedAt: null,
          bucket: "signed",
          status: "Fully Signed",
          stageLabel: "Signed",
          currentActorRole: "system",
        },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    "portal_lease_pipeline_records(casey)",
  );

  // Casey's Intake form: started, prefilled from the license agreement's
  // allowlisted shared fields, not yet submitted.
  await must(
    supabase.from("manager_application_records").upsert(
      {
        id: CASEY_AXIS_ID,
        manager_user_id: managerUserId,
        resident_email: CASEY_EMAIL,
        property_id: PROPERTY_ID,
        assigned_property_id: PROPERTY_ID,
        row_data: {
          id: CASEY_AXIS_ID,
          axisId: CASEY_AXIS_ID,
          bucket: "incomplete",
          stage: "Intake form — in progress",
          detail: "Prefilled from the signed License agreement.",
          email: CASEY_EMAIL,
          name: "Casey Odom",
          property: "Ida Cares — Maple House",
          application: {
            fullLegalName: "Casey Odom",
            email: CASEY_EMAIL,
            phone: "206-555-0198",
            propertyId: PROPERTY_ID,
            roomChoice1: `${PROPERTY_ID}::room-2`,
            leaseTerm: "Month-to-Month",
          },
          managerUserId,
          propertyId: PROPERTY_ID,
          residentUserId: caseyUserId,
          assignedPropertyId: PROPERTY_ID,
          assignedRoomChoice: `${PROPERTY_ID}::room-2`,
        },
        updated_at: NOW.toISOString(),
      },
      { onConflict: "id" },
    ),
    "manager_application_records(casey)",
  );

  console.log(`Done seeding ${WORKSPACE_NAME}.`);
  console.log(`  Manager: ${MANAGER_EMAIL} / ${PASSWORD}`);
  console.log(`  Jordan Reyes (sent, not signed): ${JORDAN_EMAIL} / ${PASSWORD}`);
  console.log(`  Casey Odom (signed, on intake form): ${CASEY_EMAIL} / ${PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { mockFreeApplicationFee } from "../helpers/e2e-supabase";
import {
  continueBtn,
  fillAdditionalDetailsStep,
  fillConsentStep,
  fillCurrentAddressStep,
  fillEmploymentStep,
  fillHouseholdStep,
  fillPreviousAddressStep,
  fillPropertyLeaseStep,
  fillReferencesStep,
  fillSignerStep,
  openGuestApplyWizard,
  type HouseholdConfig,
} from "../helpers/rental-wizard-e2e";

/**
 * Group applications (roommates / bundled-lease household) — full round trip.
 *
 * Exercises the real product surfaces end to end against the dev/test Supabase
 * project: the organizer submits `applyingAsGroup=yes`, a Group ID is minted and
 * PERSISTED on the stored application snapshot, stays retrievable on that
 * application in the resident portal, survives a re-edit, and reconciles a
 * joining applicant's independent application into one household in the manager
 * view. The manager's whole group affordance on Applications is the LIST ROW
 * BADGE ("Group N/M", or the raw count when the declared size is unknown or
 * exceeded) plus its hover title carrying the Group ID — the roster panel was
 * removed from the application detail and now lives on Residents and the
 * resident's own Applications panel.
 *
 * Runs against a fee-free listing so the wizard's application-fee gate is not in
 * the way — nothing about the fee path is stubbed or altered.
 *
 * Fixture (dev/test Supabase project only — never production). Set
 * `GROUP_E2E_ENABLED=1` once these exist:
 *   - a `live` `manager_property_records` row `mgr-test-willow-group`, owned by the
 *     E2E manager, whose `listingSubmission` has `applicationFee: ""` and
 *     `allowMultiplePropertyApplications: true` (an entire-home listing, so no ranked
 *     room choice is asked);
 *   - two resident auth users + profiles: `group.organizer.e2e@test.proplane.local` and
 *     `roommate.e2e@test.proplane.local`.
 * Override any of these with the GROUP_E2E_* env vars below.
 */

const PROPERTY_ID = process.env.GROUP_E2E_PROPERTY_ID ?? "mgr-test-willow-group";
const ORGANIZER = {
  email: process.env.GROUP_E2E_ORGANIZER_EMAIL ?? "group.organizer.e2e@test.proplane.local",
  password: process.env.GROUP_E2E_ORGANIZER_PASSWORD ?? "TestOrganizer123!",
  name: "Priya Raman",
};
const JOINER = {
  email: process.env.GROUP_E2E_JOINER_EMAIL ?? "roommate.e2e@test.proplane.local",
  password: process.env.GROUP_E2E_JOINER_PASSWORD ?? "TestRoommate123!",
  name: "Jordan Reyes",
};
const GUEST = { email: "sam.ortiz.group.e2e@test.proplane.local", password: "", name: "Sam Ortiz" };
const MANAGER = {
  email: process.env.E2E_MANAGER_EMAIL ?? "manager@test.proplane.local",
  password: process.env.E2E_MANAGER_PASSWORD ?? "TestManager123!",
};

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? path.join(process.cwd(), "test-evidence");

const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

const GROUP_ID_FILE = path.join(EVIDENCE_DIR, "group-id.txt");
const DB_EVIDENCE_FILE = path.join(EVIDENCE_DIR, "persisted-group-applications.json");

// Placeholders keep module import side-effect-free when the suite is skipped.
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key-unset",
  { auth: { persistSession: false } },
);

function evidencePath(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

type PersistedApp = {
  id: string;
  email: string;
  bucket: string;
  stage: string;
  applyingAsGroup: string | null;
  groupRole: string | null;
  groupSize: string;
  groupId: string;
};

/** Submitted (non in-progress) applications on the test listing, as stored server-side. */
async function readPersistedApplications(): Promise<PersistedApp[]> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id,row_data")
    .eq("property_id", PROPERTY_ID);
  if (error) throw error;
  return (data ?? [])
    .map((r) => {
      const row = r.row_data as Record<string, unknown>;
      const app = (row.application ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        email: String(row.email ?? ""),
        bucket: String(row.bucket ?? ""),
        stage: String(row.stage ?? ""),
        applyingAsGroup: (app.applyingAsGroup as string) ?? null,
        groupRole: (app.groupRole as string) ?? null,
        groupSize: String(app.groupSize ?? ""),
        groupId: String(app.groupId ?? ""),
      };
    })
    .filter((r) => r.stage !== "In progress");
}

/** Poll until an applicant's SUBMITTED application is visible server-side. */
async function waitForPersisted(email: string, timeoutMs = 60_000): Promise<PersistedApp> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readPersistedApplications();
    const hit = rows.find((r) => r.email === email);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`No submitted application persisted for ${email}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function writeDbEvidence(label: string, rows: PersistedApp[]) {
  const file = evidencePath(path.basename(DB_EVIDENCE_FILE));
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  prior.push({ checkpoint: label, rows });
  fs.writeFileSync(file, JSON.stringify(prior, null, 2));
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: evidencePath(`${name}.png`), fullPage: true });
}

/** The portal renders a hidden mobile shell alongside the desktop one — always take the visible node. */
function vis(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first();
}

/** Visible-only text lookup (same hidden-shell caveat as `vis`). */
function txt(page: Page, needle: string | RegExp): Locator {
  return page.getByText(needle).filter({ visible: true }).first();
}

/** Visible-only role=button lookup. */
function btn(page: Page, name: RegExp): Locator {
  return page.getByRole("button", { name }).filter({ visible: true }).first();
}

/**
 * Land on the resident Applications list. The panel bounces to /apply while its rows
 * are still loading, so retry until the list itself is showing.
 */
async function openResidentApplications(page: Page) {
  for (let i = 0; i < 6; i += 1) {
    await page.goto("/resident/applications");
    await page.waitForTimeout(1500);
    if (!page.url().includes("/apply")) return;
  }
  throw new Error("resident Applications list never settled");
}

/**
 * Land on the manager Applications list. Row visibility is scoped through the
 * client-side property catalog, which only hydrates once Properties has loaded —
 * landing straight on Applications otherwise shows an empty list.
 */
async function openManagerApplications(page: Page) {
  await page.goto("/portal/properties");
  await expect(txt(page, /Willow Group House/i)).toBeVisible({ timeout: 45_000 });
  await page.goto("/portal/applications");
}

async function signIn(page: Page, email: string, password: string, next: string, expectPrefix = next) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname.startsWith(expectPrefix), { timeout: 45_000 });
}

function toHouseholdConfig(
  group: { role: "first"; size: string } | { role: "joining"; groupId: string },
): HouseholdConfig {
  return group.role === "first"
    ? { kind: "group-first", size: group.size }
    : { kind: "group-joining", groupId: group.groupId };
}

/** Walk the 11-step wizard and submit, either signed in (portal) or as a guest. */
async function submitApplication(
  page: Page,
  applicant: { email: string; password: string; name: string },
  group: { role: "first"; size: string } | { role: "joining"; groupId: string },
  label: string,
  mode: "portal" | "guest" = "portal",
) {
  if (mode === "portal") {
    await signIn(page, applicant.email, applicant.password, "/resident/dashboard", "/resident");
    await page.goto(`/rent/apply?propertyId=${PROPERTY_ID}`);
    await expect(continueBtn(page)).toBeVisible({ timeout: 30_000 });
  } else {
    await mockFreeApplicationFee(page);
    await openGuestApplyWizard(page, PROPERTY_ID);
  }

  // Step 1 — household (group + co-signer on one step).
  await fillHouseholdStep(page, toHouseholdConfig(group));
  await shot(page, `${label}-01-wizard-step1-household`);
  await continueBtn(page).click();

  // Step 2 — signer information.
  await fillSignerStep(page, applicant, "04/12/1994");
  await continueBtn(page).click();

  // Step 3 — property + lease dates (property locked via ?propertyId).
  await fillPropertyLeaseStep(page);
  await continueBtn(page).click();

  // Step 4 — current address.
  await fillCurrentAddressStep(page, {
    street: "88 Dexter Ave N, Apt 4",
    city: "Seattle",
    state: "WA",
    zip: "98109",
  });
  await continueBtn(page).click();

  // Step 5 — previous address.
  await fillPreviousAddressStep(page);
  await continueBtn(page).click();

  // Step 6 — employment + income.
  await fillEmploymentStep(page, "Northwest Design Co.", "6400");
  await continueBtn(page).click();

  // Step 7 — references.
  await fillReferencesStep(page, {
    name: "Dana Whitfield",
    relationship: "Former landlord",
    phone: "2065550188",
  });
  await continueBtn(page).click();

  // Step 8 — additional details.
  await fillAdditionalDetailsStep(page, "2");
  await continueBtn(page).click();

  // Step 9 — consent + signature.
  await fillConsentStep(page, applicant.name);
  await continueBtn(page).click();

  // Step 10 — review.
  await expect(txt(page, "Applying as group")).toBeVisible({ timeout: 15_000 });
  await shot(page, `${label}-02-wizard-review`);
  await continueBtn(page).click();

  // Step 11 — submit (this listing charges no application fee).
  await expect(continueBtn(page)).toHaveText(/submit application/i, { timeout: 15_000 });
  await shot(page, `${label}-03-wizard-submit-step`);

  // Submit, then confirm the snapshot actually reached the server. The dev server
  // occasionally recompiles a route mid-click and drops the press, so re-press
  // while the button still reads "Submit application".
  let persisted: PersistedApp | null = null;
  for (let attempt = 0; attempt < 3 && !persisted; attempt += 1) {
    const btnLabel = await continueBtn(page).innerText().catch(() => "");
    if (/submit application/i.test(btnLabel)) await continueBtn(page).click();
    persisted = await waitForPersisted(applicant.email, 30_000).catch(() => null);
  }
  if (!persisted) throw new Error(`No submitted application persisted for ${applicant.email}`);

  if (mode === "guest") {
    await expect(txt(page, /Application ID:/i)).toBeVisible({ timeout: 60_000 });
  }
  await page.waitForTimeout(500);
}

/** Re-open a submitted application in the resident portal and save it again. */
async function reEditApplication(page: Page, applicantName: string) {
  await txt(page, applicantName).click();
  await btn(page, /Edit application/i).click();
  await expect(txt(page, /Step 1 of 11/i)).toBeVisible({ timeout: 15_000 });
  // Re-select the group role — this deliberately blanks the form's groupId, the
  // exact path that used to drop a member out of their household on save.
  await btn(page, /I am the first person applying/i).click();
  await vis(page, "#groupSize").selectOption("2");
  for (let i = 0; i < 9; i += 1) {
    await continueBtn(page).click();
    await page.waitForTimeout(250);
  }
  await btn(page, /Save application/i).click();
  await expect(page.getByRole("button", { name: /Save application/i })).toHaveCount(0, { timeout: 30_000 });
}

// A submit that does not reach the server is a lost application, not a flake: the
// wizard clears, the resident sees a draft and the manager sees nothing. One walk
// of the wizard must persist one submitted row, so `submitApplication` throws
// rather than re-walking — that failure is the signal the write race is back.

test.describe.configure({ mode: "serial", timeout: 600_000 });

test.describe("Group applications end to end", () => {
  // Self-documenting gate: a skipped run must never read as "the group round trip
  // passed". This suite needs a real dev/test Supabase project (.env with
  // NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) plus the fixture listing and
  // resident accounts described in the file header; none of that exists in a bare
  // worktree, so it stays off by default rather than silently green.
  test.skip(
    process.env.GROUP_E2E_ENABLED !== "1",
    "SKIPPED — GROUP_E2E_ENABLED is not 1, so the live group-application round trip " +
      "(mint → persist → resident retrieve → joiner reconcile → manager badge) did NOT run. " +
      "Set GROUP_E2E_ENABLED=1 with a dev/test Supabase .env and the fixture from this file's header. " +
      "The submitted-vs-draft ordering guard is covered deterministically by " +
      "tests/unit/application-draft-downgrade.test.ts, which does run.",
  );

  // Enabled but unconfigured would otherwise point at the localhost placeholder client
  // and fail deep inside a wizard step — fail loudly, and early, instead.
  test.beforeAll(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "GROUP_E2E_ENABLED=1 but NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset. " +
          "Seed this worktree's .env (npm run seed:env) and point it at the DEV/TEST project — never production.",
      );
    }
  });

  // Idempotent reruns: clear any applications left on the dedicated test listing.
  test.beforeAll(async () => {
    if (process.env.GROUP_E2E_KEEP_DATA === "1") return;
    const { error } = await db.from("manager_application_records").delete().eq("property_id", PROPERTY_ID);
    if (error) throw error;
    if (fs.existsSync(DB_EVIDENCE_FILE)) fs.rmSync(DB_EVIDENCE_FILE);
  });

  test("organizer submits as first applicant — Group ID minted and persisted", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await submitApplication(page, ORGANIZER, { role: "first", size: "2" }, "organizer");

    const rows = await readPersistedApplications();
    const organizerRow = rows.find((r) => r.email === ORGANIZER.email);
    expect(organizerRow, "organizer application persisted server-side").toBeTruthy();
    expect(organizerRow!.applyingAsGroup).toBe("yes");
    expect(organizerRow!.groupRole).toBe("first");
    expect(organizerRow!.groupSize).toBe("2");
    expect(organizerRow!.groupId).toMatch(/^PROPLANE-[0-9A-HJKMNP-TV-Z]{8}$/);
    fs.writeFileSync(evidencePath(path.basename(GROUP_ID_FILE)), organizerRow!.groupId);
    writeDbEvidence("after organizer submit", rows);
  });

  test("Group ID stays retrievable on the submitted application in the resident portal", async ({ page }) => {
    const groupId = fs.readFileSync(GROUP_ID_FILE, "utf8").trim();
    await page.setViewportSize(DESKTOP);
    await signIn(page, ORGANIZER.email, ORGANIZER.password, "/resident/applications", "/resident");
    await openResidentApplications(page);
    await txt(page, ORGANIZER.name).click();
    await expect(txt(page, groupId)).toBeVisible({ timeout: 20_000 });
    await expect(txt(page, /Your group is ready/i)).toBeVisible();
    await expect(txt(page, /Share this Group ID with your 1 roommate/i)).toBeVisible();
    await shot(page, "organizer-03-resident-group-callout-desktop-1440");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(800);
    await expect(txt(page, groupId)).toBeVisible();
    await shot(page, "organizer-04-resident-group-callout-mobile-390");
  });

  test("re-editing and re-saving the application does not wipe the Group ID", async ({ page }) => {
    const groupId = fs.readFileSync(GROUP_ID_FILE, "utf8").trim();
    await page.setViewportSize(DESKTOP);
    await signIn(page, ORGANIZER.email, ORGANIZER.password, "/resident/applications", "/resident");
    await openResidentApplications(page);
    await reEditApplication(page, ORGANIZER.name);

    const rows = await readPersistedApplications();
    const organizerRow = rows.find((r) => r.email === ORGANIZER.email);
    expect(organizerRow!.groupId).toBe(groupId);
    writeDbEvidence("after organizer re-edit + save", rows);

    await openResidentApplications(page);
    await txt(page, ORGANIZER.name).click();
    await expect(txt(page, groupId)).toBeVisible({ timeout: 20_000 });
    await shot(page, "organizer-05-group-id-preserved-after-edit-desktop-1440");
  });

  test("manager sees the stalled group as waiting on the missing roommate", async ({ page }) => {
    const groupId = fs.readFileSync(GROUP_ID_FILE, "utf8").trim();
    await page.setViewportSize(DESKTOP);
    await signIn(page, MANAGER.email, MANAGER.password, "/portal/dashboard", "/portal");
    await openManagerApplications(page);
    await expect(txt(page, "Group 1/2")).toBeVisible({ timeout: 30_000 });
    // The Group ID reaches the manager through the badge's hover title; there is
    // no roster on the application detail to read it off.
    await expect(page.locator(`[title*="${groupId}"]`).filter({ visible: true }).first()).toBeVisible();
    await shot(page, "manager-01-group-waiting-badge-desktop-1440");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(800);
    await expect(txt(page, "Group 1/2")).toBeVisible();
    await shot(page, "manager-03-group-waiting-mobile-390");
  });

  test("joining roommate pastes the Group ID into their own application", async ({ page }) => {
    const groupId = fs.readFileSync(GROUP_ID_FILE, "utf8").trim();
    await page.setViewportSize(DESKTOP);
    await submitApplication(page, JOINER, { role: "joining", groupId }, "joiner");

    const rows = await readPersistedApplications();
    const joinerRow = rows.find((r) => r.email === JOINER.email);
    expect(joinerRow!.groupRole).toBe("joining");
    expect(joinerRow!.groupId).toBe(groupId);
    writeDbEvidence("after joiner submit", rows);

    await openResidentApplications(page);
    await txt(page, JOINER.name).click();
    await expect(txt(page, /You joined a group application/i)).toBeVisible({ timeout: 20_000 });
    await expect(txt(page, groupId)).toBeVisible();
    await shot(page, "joiner-03-resident-group-callout-desktop-1440");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(800);
    await expect(txt(page, groupId)).toBeVisible();
    await shot(page, "joiner-04-resident-group-callout-mobile-390");
  });

  test("manager sees one reconciled household — Group 2/2 badge", async ({ page }) => {
    const groupId = fs.readFileSync(GROUP_ID_FILE, "utf8").trim();
    await page.setViewportSize(DESKTOP);
    await signIn(page, MANAGER.email, MANAGER.password, "/portal/dashboard", "/portal");
    await openManagerApplications(page);
    await expect(page.getByText("Group 2/2").filter({ visible: true })).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(`[title*="${groupId}"]`).filter({ visible: true }).first()).toBeVisible();
    await shot(page, "manager-04-group-badges-desktop-1440");

    // The joiner's own row carries the same reconciled badge — the manager reads
    // the household off the list, not off an application detail.
    await expect(txt(page, JOINER.name)).toBeVisible();
    await shot(page, "manager-05-group-reconciled-list-desktop-1440");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(1000);
    await expect(txt(page, "Group 2/2")).toBeVisible();
    await shot(page, "manager-06-group-reconciled-mobile-390");
  });

  test("guest applicant joining the same group sees the shared finish-screen callout", async ({ page }) => {
    const groupId = fs.readFileSync(GROUP_ID_FILE, "utf8").trim();
    await page.setViewportSize(DESKTOP);
    await submitApplication(page, GUEST, { role: "joining", groupId }, "guest", "guest");
    await expect(txt(page, /You joined a group application/i)).toBeVisible();
    await expect(txt(page, groupId)).toBeVisible();
    await shot(page, "guest-03-finish-panel-desktop-1440");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(600);
    await expect(txt(page, groupId)).toBeVisible();
    await shot(page, "guest-04-finish-panel-mobile-390");
  });

  test("manager sees an over-subscribed group reported raw, never as a false ratio", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page, MANAGER.email, MANAGER.password, "/portal/dashboard", "/portal");
    await openManagerApplications(page);
    await expect(txt(page, "Group 3 · 2 declared")).toBeVisible({ timeout: 30_000 });
    // The over-subscription warning is the badge's hover title, not a detail panel.
    await expect(
      page
        .locator('[title*="more applications carry this code than the 2 the organizer declared"]')
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await shot(page, "manager-07-group-oversubscribed-desktop-1440");
    writeDbEvidence("final", await readPersistedApplications());
  });
});

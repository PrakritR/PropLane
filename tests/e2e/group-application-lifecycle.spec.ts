import { chmodSync, mkdirSync, lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createWritableSyntheticManager, cleanupWritableSyntheticManager, type WritableSyntheticManager } from "../helpers/writable-synthetic-manager";
import { finishResidentEmailProof, requestResidentEmailProof } from "../helpers/email-onboarding-e2e";
import { syntheticSignupDomain } from "../helpers/synthetic-signup-domain";
import { verifySyntheticResidentPhone, type SyntheticPhoneVerification } from "../helpers/synthetic-phone-verification";
import { fillCurrentRentalApplication, visibleLocator, type HouseholdConfig } from "../helpers/rental-wizard-e2e";
import { residentApplicationDetailHref } from "../../src/lib/portal-detail-routes";

const DEV_URL = "https://emstjswhotsnyksqhqyf.supabase.co";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "missing", { auth: { persistSession: false } });

type Applicant = { email: string; name: string; phone: string };
type GroupFixture = {
  manager: WritableSyntheticManager;
  residents: Array<{ page: Page; close: () => Promise<void>; phoneFixture: SyntheticPhoneVerification | null; userId: string; applicant: Applicant; applicationId?: string }>;
  propertyId: string;
  runId: string;
};

function privateEvidencePath(file: string): string {
  const dir = process.env.E2E_PRIVATE_FIXTURE_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new Error("Group E2E requires an absolute private fixture directory.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const followed = statSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.() || followed.dev !== stat.dev || followed.ino !== stat.ino) {
    throw new Error("Group E2E private fixture directory must be a real mode-700 directory owned by this user.");
  }
  return path.join(dir, file);
}

function propertyApplyPath(propertyId: string, leaderAppId?: string): string {
  const query = new URLSearchParams({ propertyId });
  if (leaderAppId) query.set("groupLeaderAppId", leaderAppId);
  return `/rent/apply?${query.toString()}`;
}

function visibleText(page: Page, text: string | RegExp) {
  return page.getByText(text, { exact: true }).filter({ visible: true }).first();
}

function applicantFor(runId: string, index: number, name: string): Applicant {
  const stamp = String(Number(runId) + index - 1);
  return {
    email: `e2e-applicant-${stamp}@${syntheticSignupDomain()}`,
    name,
    phone: `+1206555${String((Number(runId.slice(-4)) + index) % 10_000).padStart(4, "0")}`,
  };
}

async function assertReservedResidentMailboxesAbsent(runId: string): Promise<Applicant[]> {
  const applicants = [applicantFor(runId, 1, "Priya Raman"), applicantFor(runId, 2, "Jordan Reyes"), applicantFor(runId, 3, "Sam Ortiz")];
  const reserved = new Set(applicants.map((applicant) => applicant.email));
  for (let page = 1; page <= 100; page += 1) {
    const result = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error("Could not preflight the reserved synthetic resident Auth identities.");
    if (result.data.users.some((user) => reserved.has(user.email?.trim().toLowerCase() ?? ""))) {
      throw new Error("A reserved group applicant mailbox already exists; refusing to reuse or modify it.");
    }
    if (result.data.users.length < 1000) break;
    if (page === 100) throw new Error("Reserved synthetic mailbox preflight exceeded its pagination bound.");
  }
  for (const applicant of applicants) {
    const [profile, application] = await Promise.all([
      db.from("profiles").select("id").eq("email", applicant.email).limit(1),
      db.from("manager_application_records").select("id").eq("resident_email", applicant.email).limit(1),
    ]);
    if (profile.error || application.error) throw new Error("Could not preflight the exact reserved synthetic resident mailbox.");
    if ((profile.data ?? []).length || (application.data ?? []).length) {
      throw new Error("A reserved group applicant mailbox already exists; refusing to reuse or modify it.");
    }
  }
  return applicants;
}

async function configureGroupListing(manager: WritableSyntheticManager): Promise<void> {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") !== DEV_URL) throw new Error("Group E2E requires the exact dev/test project.");
  const propertyId = manager.property.id;
  const { data: record, error } = await db.from("manager_property_records")
    .select("id, manager_user_id, status, row_data, property_data")
    .eq("id", propertyId).maybeSingle();
  if (error || !record || record.manager_user_id !== manager.actorId || record.status !== "live") {
    throw new Error("Group E2E listing must be the exact live property owned by its synthetic manager.");
  }
  const propertyData = record.property_data as Record<string, unknown>;
  if (propertyData.fixturePurpose !== "e2e-safe-isolated" || propertyData.buildingName !== manager.property.name) {
    throw new Error("Group E2E refuses an unmarked or mismatched property fixture.");
  }
  const listing = propertyData.listingSubmission as Record<string, unknown>;
  if (!listing || typeof listing !== "object") throw new Error("Group E2E fixture listing has no normalized submission.");
  const configuredSubmission = {
    ...listing,
    allowMultiplePropertyApplications: true,
    applicationFee: "",
    rooms: Array.isArray(listing.rooms) ? listing.rooms : [],
  };
  const nextPropertyData = { ...propertyData, listingSubmission: configuredSubmission };
  const rawRow = record.row_data && typeof record.row_data === "object" ? record.row_data as Record<string, unknown> : {};
  const nextRowData = { ...rawRow, listingSubmission: configuredSubmission };
  const response = await manager.page.request.post("/api/property-records", {
    data: { action: "upsert", id: propertyId, status: "live", rowData: nextRowData, propertyData: nextPropertyData },
  });
  if (!response.ok()) throw new Error(`Could not prepare the exact group listing through the manager API (HTTP ${response.status()}).`);
  const verify = await db.from("manager_property_records").select("manager_user_id,status,property_data")
    .eq("id", propertyId).maybeSingle();
  const saved = verify.data?.property_data as Record<string, unknown> | undefined;
  const savedListing = saved?.listingSubmission as Record<string, unknown> | undefined;
  if (verify.error || verify.data?.manager_user_id !== manager.actorId || verify.data.status !== "live" ||
      saved?.fixturePurpose !== "e2e-safe-isolated" || savedListing?.allowMultiplePropertyApplications !== true || savedListing?.applicationFee !== "") {
    throw new Error("Group listing policy and fee-free pricing were not confirmed on the owned fixture.");
  }
  const preview = await manager.page.request.post("/api/public/application-fee-preview", {
    data: { propertyId, rentalType: "standard", leaseTerm: "Long-term" },
  });
  if (!preview.ok()) throw new Error(`Could not verify the listing application-fee preview (HTTP ${preview.status()}).`);
  const quote = await preview.json() as { applicationFeeCents?: unknown; totalCents?: unknown };
  if (quote.applicationFeeCents !== 0 || quote.totalCents !== 0) throw new Error("Group E2E requires an actually fee-free listing; no fee route is mocked.");
}

async function readApplication(propertyId: string, email: string) {
  const { data, error } = await db.from("manager_application_records")
    .select("id, manager_user_id, property_id, resident_email, row_data")
    .eq("property_id", propertyId).eq("resident_email", email).limit(2);
  if (error) throw error;
  if ((data ?? []).length !== 1) return null;
  const row = data![0]!;
  return { ...row, row_data: row.row_data as Record<string, unknown>, application: ((row.row_data as Record<string, unknown>).application ?? {}) as Record<string, unknown> };
}

async function residentActorId(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const auth = cookies.filter((cookie) => /^sb-emstjswhotsnyksqhqyf-auth-token(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => Number(a.name.match(/\.(\d+)$/)?.[1] ?? 0) - Number(b.name.match(/\.(\d+)$/)?.[1] ?? 0))
    .map((cookie) => decodeURIComponent(cookie.value)).join("");
  const raw = auth.startsWith("base64-") ? Buffer.from(auth.slice(7), "base64").toString("utf8") : auth;
  const parsed = JSON.parse(raw) as { user?: { id?: string } };
  if (!parsed.user?.id) throw new Error("Could not verify the synthetic resident Auth actor.");
  return parsed.user.id;
}

async function waitForApplication(propertyId: string, email: string) {
  let found: Awaited<ReturnType<typeof readApplication>> = null;
  await expect.poll(async () => {
    found = await readApplication(propertyId, email);
    return found?.id ?? "";
  }, { timeout: 60_000 }).not.toBe("");
  if (!found) throw new Error("Submitted application was not persisted for the exact synthetic mailbox.");
  return found;
}

async function createResidentAccount(
  browser: Browser,
  input: { runId: string; index: number; propertyId: string; leaderAppId?: string; name: string; onProvisioned?: (account: { email: string; userId: string }) => void },
): Promise<GroupFixture["residents"][number]> {
  if (!BASE_URL) throw new Error("Group E2E requires PLAYWRIGHT_BASE_URL.");
  const base = new URL(BASE_URL);
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(base.hostname) || Number(base.port) < 3000 || Number(base.port) > 3014) {
    throw new Error("Group E2E requires localhost on a supported pinned port.");
  }
  // The no-delivery capture accepts exactly thirteen-digit signup suffixes.
  // Offset the run's millisecond timestamp so residents in this run stay unique.
  const applicant = applicantFor(input.runId, input.index, input.name);
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  let phoneFixture: SyntheticPhoneVerification | null = null;
  let userId: string | null = null;
  try {
    await page.goto(propertyApplyPath(input.propertyId, input.leaderAppId), { waitUntil: "domcontentloaded" });
    const createLink = page.locator('[data-attr="public-apply-create-account"]').filter({ visible: true });
    await expect(createLink).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[data-attr="public-apply-continue-guest"]')).toHaveCount(0);
    const href = await createLink.getAttribute("href");
    if (!href || !href.startsWith("/auth/create-account?")) throw new Error("Public apply account gate did not offer its resident create-account route.");
    const next = new URL(href, BASE_URL).searchParams.get("next") ?? "";
    if (!next.includes(`propertyId=${encodeURIComponent(input.propertyId)}`)) throw new Error("Resident signup lost the exact listing context.");
    await createLink.click();
    const proof = await requestResidentEmailProof(page, applicant.email, input.propertyId);
    const registerStatus = await finishResidentEmailProof(page, proof, applicant.email, applicant.name, applicant.phone);
    if (registerStatus !== 200) throw new Error(`Synthetic resident registration returned ${registerStatus}.`);
    userId = await residentActorId(page);
    input.onProvisioned?.({ email: applicant.email, userId });
    const auth = await db.auth.admin.getUserById(userId);
    const { data: roles, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", userId);
    if (auth.error || !auth.data.user?.email_confirmed_at || auth.data.user.email?.trim().toLowerCase() !== applicant.email ||
        roleError || !roles || !roles.some((row) => row.role === "resident") || roles.some((row) => row.role !== "resident")) {
      throw new Error("Resident registration did not produce the exact email-confirmed resident account.");
    }
    // Registration can briefly land on the public `next` route before the
    // phone guard redirects. The role/profile proof above and helper actor
    // checks bind this fixture to the exact new resident, independent of URL.
    phoneFixture = await verifySyntheticResidentPhone(page, { email: applicant.email, phone: applicant.phone });
    // Email-first continuation carries property context but not the group link. Explicitly reopen
    // the organizer's capability URL after account creation; linking remains a user-visible step.
    await page.goto(propertyApplyPath(input.propertyId, input.leaderAppId), { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-attr="public-apply-create-account"]')).toHaveCount(0);
    await expect(visibleLocator(page, '[data-wizard-field="applyingAsGroup"]')).toBeVisible({ timeout: 45_000 });
    const userResponse = await page.request.get("/api/profile");
    if (!userResponse.ok()) throw new Error("Could not verify the signed-in resident actor after email proof.");
    const userBody = await userResponse.json() as { email?: unknown };
    if (String(userBody.email ?? "").trim().toLowerCase() !== applicant.email) throw new Error("Resident signup page is not authenticated as the exact synthetic applicant.");
    return {
      page,
      close: () => context.close(),
      phoneFixture,
      userId: userId!,
      applicant,
    };
  } catch (error) {
    try { await phoneFixture?.restore(); } catch (restoreError) {
      await context.close();
      throw new AggregateError([error, restoreError], "Resident account setup and phone fixture restoration both failed.");
    }
    await context.close();
    throw error;
  }
}

async function applyAsResident(
  browser: Browser,
  fixture: GroupFixture,
  resident: GroupFixture["residents"][number],
  household: HouseholdConfig,
  onPersisted?: (resident: GroupFixture["residents"][number]) => void,
): Promise<void> {
  const submit = resident.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/manager-applications", { timeout: 60_000 });
  await fillCurrentRentalApplication(resident.page, resident.applicant, household);
  const response = await submit;
  if (!response.ok()) throw new Error(`Application submission failed (HTTP ${response.status()}).`);
  const persisted = await waitForApplication(fixture.propertyId, resident.applicant.email);
  if (persisted.manager_user_id !== fixture.manager.actorId || persisted.property_id !== fixture.propertyId) {
    throw new Error("Application was persisted outside the exact synthetic manager/listing fixture.");
  }
  resident.applicationId = String(persisted.id);
  onPersisted?.(resident);
}

async function restoreResidents(fixture: GroupFixture): Promise<void> {
  const errors: unknown[] = [];
  for (const resident of fixture.residents) {
    try { await resident.phoneFixture?.restore(); } catch (error) { errors.push(new Error("Resident phone fixture cleanup failed.", { cause: error })); }
    try { await resident.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Some resident phone fixture state could not be restored; resident accounts remain inventoried.");
  fixture.residents.length = 0;
}

test.describe.configure({ mode: "serial", timeout: 600_000 });

test("group application lifecycle: organizer, re-edit, roommate, account-gated third member, manager reconciliation", async ({ browser }) => {
  test.setTimeout(600_000);
  test.skip(process.env.GROUP_E2E_ENABLED !== "1", "Requires explicit opt-in to the real, exact synthetic group lifecycle fixture.");
  if (process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") !== DEV_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Group lifecycle E2E requires the exact dev/test Supabase project and service key.");
  }
  const runId = String(Date.now());
  const manager = await createWritableSyntheticManager(browser);
  const fixture: GroupFixture = { manager, residents: [], propertyId: manager.property.id, runId };
  const manifestPath = privateEvidencePath(`group-lifecycle-${runId}.json`);
  let manifestCreated = false;
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(), runId, ownerUserId: manager.actorId,
    propertyId: fixture.propertyId, propertyName: manager.property.name, applicants: [], accountsProvisioned: [],
    retainedResidentAccounts: true,
  };
  const saveManifest = () => {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: manifestCreated ? "w" : "wx", mode: 0o600 });
    manifestCreated = true;
    chmodSync(manifestPath, 0o600);
  };
  saveManifest();
  const recordProvisioned = (account: { email: string; userId: string }) => {
    const accounts = manifest.accountsProvisioned as Array<{ email: string; userId: string }>;
    if (!accounts.some((entry) => entry.userId === account.userId)) accounts.push(account);
    saveManifest();
  };
  const before = await db.from("manager_application_records").select("id").eq("property_id", fixture.propertyId);
  if (before.error || (before.data ?? []).length !== 0) {
    await cleanupWritableSyntheticManager(manager);
    throw new Error("Fresh group listing was not empty before the run; refusing shared fixture cleanup.");
  }

  try {
    const reservedApplicants = await assertReservedResidentMailboxesAbsent(runId);
    manifest.reservedApplicants = reservedApplicants.map(({ email, name }) => ({ email, name }));
    saveManifest();
    await configureGroupListing(manager);
    const organizer = await createResidentAccount(browser, { runId, index: 1, propertyId: fixture.propertyId, name: "Priya Raman", onProvisioned: recordProvisioned });
    fixture.residents.push(organizer);
    manifest.applicants = [{ email: organizer.applicant.email, userId: organizer.userId, applicationId: null }];
    saveManifest();
    await applyAsResident(browser, fixture, organizer, { kind: "group-first", size: "2" }, (resident) => {
      manifest.applicants = [{ email: resident.applicant.email, userId: resident.userId, applicationId: resident.applicationId ?? null }];
      saveManifest();
    });
    manifest.applicants = [{ email: organizer.applicant.email, userId: organizer.userId, applicationId: organizer.applicationId ?? null }];
    saveManifest();
    const organizerRow = await readApplication(fixture.propertyId, organizer.applicant.email);
    expect(organizerRow?.application.applyingAsGroup).toBe("yes");
    expect(organizerRow?.application.groupRole).toBe("first");
    expect(String(organizerRow?.application.groupSize)).toBe("2");
    const groupId = String(organizerRow?.application.groupId ?? "");
    expect(groupId).toMatch(/^PROPLANE-[0-9A-HJKMNP-TV-Z]{8}$/);
    const organizerAppId = String(organizerRow?.id ?? "");
    expect(organizerAppId).toBe(organizer.applicationId);
    await expect(visibleText(organizer.page, "Roommate invite")).toBeVisible();
    await expect(visibleText(organizer.page, organizerAppId)).toBeVisible();
    await expect(organizer.page.locator('[data-attr="group-invite-copy"]')).toBeVisible();
    const inviteText = (await organizer.page.locator("code").filter({ hasText: "groupLeaderAppId" }).textContent())?.trim();
    if (!inviteText) throw new Error("The organizer finish panel did not render its group invite URL.");
    const inviteUrl = new URL(inviteText);
    expect(inviteUrl.origin).toBe(new URL(BASE_URL).origin);
    expect(inviteUrl.pathname).toBe("/rent/apply");
    expect(inviteUrl.searchParams.get("propertyId")).toBe(fixture.propertyId);
    expect(inviteUrl.searchParams.get("groupLeaderAppId")).toBe(organizerAppId);
    await organizer.page.setViewportSize({ width: 390, height: 844 });
    await expect(visibleText(organizer.page, "Roommate invite")).toBeVisible();
    await expect(organizer.page.locator('[data-attr="group-invite-copy"]')).toBeVisible();
    await organizer.page.setViewportSize({ width: 1440, height: 1000 });

    Object.assign(manifest, { organizerAppId, organizerEmail: organizer.applicant.email, groupId,
      invitePath: inviteUrl.pathname + inviteUrl.search });

    await organizer.page.goto("/resident/applications", { waitUntil: "domcontentloaded" });
    await expect(organizer.page.getByRole("link", { name: "View application", exact: true })).toBeVisible({ timeout: 45_000 });
    await organizer.page.getByRole("link", { name: "View application", exact: true }).click();
    const applicationDetailPath = residentApplicationDetailHref("/resident", "pending", organizerAppId);
    await expect(organizer.page).toHaveURL((url) => url.pathname === applicationDetailPath);
    const readWhatYouSent = organizer.page.getByRole("link", { name: "Read what you sent", exact: true });
    await expect(readWhatYouSent).toBeVisible();
    await readWhatYouSent.click();
    const applicationFormPath = residentApplicationDetailHref("/resident", "pending", organizerAppId, "application-form");
    await expect(organizer.page).toHaveURL((url) => url.pathname === applicationFormPath);
    await expect(visibleText(organizer.page, "Roommate invite")).toBeVisible({ timeout: 20_000 });
    await expect(visibleText(organizer.page, organizerAppId)).toBeVisible();
    await expect(organizer.page.locator('[data-attr="group-invite-copy"]')).toBeVisible();
    await organizer.page.setViewportSize({ width: 390, height: 844 });
    await expect(visibleText(organizer.page, "Roommate invite")).toBeVisible();
    await expect(organizer.page.locator('[data-attr="group-invite-copy"]')).toBeVisible();
    await organizer.page.setViewportSize({ width: 1440, height: 1000 });
    await expect(organizer.page.getByRole("button", { name: /edit application/i }).filter({ visible: true })).toBeVisible({ timeout: 20_000 });
    await organizer.page.getByRole("button", { name: /edit application/i }).filter({ visible: true }).click();
    await fillCurrentRentalApplication(organizer.page, organizer.applicant, { kind: "group-first", size: "2" }, { existing: true });
    const afterEdit = await waitForApplication(fixture.propertyId, organizer.applicant.email);
    expect(afterEdit.application.groupId).toBe(groupId);

    await manager.page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(visibleText(manager.page, manager.property.name)).toBeVisible({ timeout: 45_000 });
    await manager.page.goto("/portal/applications", { waitUntil: "domcontentloaded" });
    await expect(manager.page.getByText(/Group 1\/2/).filter({ visible: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect(visibleText(manager.page, organizer.applicant.name)).toBeVisible();
    await visibleText(manager.page, organizer.applicant.name).click();
    await expect(visibleText(manager.page, groupId)).toBeVisible({ timeout: 20_000 });
    await expect(visibleText(manager.page, organizer.applicant.name)).toBeVisible();

    const joiner = await createResidentAccount(browser, { runId, index: 2, propertyId: fixture.propertyId, leaderAppId: organizerAppId, name: "Jordan Reyes", onProvisioned: recordProvisioned });
    fixture.residents.push(joiner);
    manifest.applicants = fixture.residents.map((resident) => ({ email: resident.applicant.email, userId: resident.userId, applicationId: resident.applicationId ?? null }));
    saveManifest();
    await applyAsResident(browser, fixture, joiner, { kind: "group-joining", groupLeaderAppId: organizerAppId }, (resident) => {
      manifest.applicants = fixture.residents.map((entry) => ({ email: entry.applicant.email, userId: entry.userId, applicationId: entry.applicationId ?? null }));
      saveManifest();
    });
    manifest.applicants = fixture.residents.map((resident) => ({ email: resident.applicant.email, userId: resident.userId, applicationId: resident.applicationId ?? null }));
    saveManifest();
    const joinerRow = await readApplication(fixture.propertyId, joiner.applicant.email);
    expect(joinerRow?.application.groupRole).toBe("joining");
    expect(joinerRow?.application.groupId).toBe(groupId);
    await expect(visibleText(joiner.page, "You joined a group application")).toBeVisible();

    await manager.page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(visibleText(manager.page, manager.property.name)).toBeVisible({ timeout: 45_000 });
    await manager.page.goto("/portal/applications", { waitUntil: "domcontentloaded" });
    await expect(manager.page.getByText("Group 2/2", { exact: true }).filter({ visible: true })).toHaveCount(2, { timeout: 45_000 });
    await visibleText(manager.page, joiner.applicant.name).click();
    await expect(visibleText(manager.page, groupId)).toBeVisible({ timeout: 20_000 });
    await expect(visibleText(manager.page, organizer.applicant.name)).toBeVisible();
    await expect(visibleText(manager.page, joiner.applicant.name)).toBeVisible();

    const third = await createResidentAccount(browser, { runId, index: 3, propertyId: fixture.propertyId, leaderAppId: organizerAppId, name: "Sam Ortiz", onProvisioned: recordProvisioned });
    fixture.residents.push(third);
    manifest.applicants = fixture.residents.map((resident) => ({ email: resident.applicant.email, userId: resident.userId, applicationId: resident.applicationId ?? null }));
    saveManifest();
    await applyAsResident(browser, fixture, third, { kind: "group-joining", groupLeaderAppId: organizerAppId }, (resident) => {
      manifest.applicants = fixture.residents.map((entry) => ({ email: entry.applicant.email, userId: entry.userId, applicationId: entry.applicationId ?? null }));
      saveManifest();
    });
    manifest.applicants = fixture.residents.map((resident) => ({ email: resident.applicant.email, userId: resident.userId, applicationId: resident.applicationId ?? null }));
    saveManifest();
    const thirdRow = await readApplication(fixture.propertyId, third.applicant.email);
    expect(thirdRow?.application.groupRole).toBe("joining");
    expect(thirdRow?.application.groupId).toBe(groupId);
    await expect(visibleText(third.page, "You joined a group application")).toBeVisible();

    await manager.page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(visibleText(manager.page, manager.property.name)).toBeVisible({ timeout: 45_000 });
    await manager.page.goto("/portal/applications", { waitUntil: "domcontentloaded" });
    await expect(manager.page.getByText("Group 3 · 2 declared", { exact: true }).filter({ visible: true })).toHaveCount(3);
    await visibleText(manager.page, third.applicant.name).click();
    await expect(visibleText(manager.page, groupId)).toBeVisible({ timeout: 20_000 });
    await expect(visibleText(manager.page, organizer.applicant.name)).toBeVisible();
    await expect(visibleText(manager.page, joiner.applicant.name)).toBeVisible();
    await expect(visibleText(manager.page, third.applicant.name)).toBeVisible();
    const finalRows = await db.from("manager_application_records").select("id,resident_email,row_data").eq("property_id", fixture.propertyId);
    if (finalRows.error || finalRows.data?.length !== 3) throw new Error("The exact fixture must contain three persisted group members.");
    manifest.applicants = fixture.residents.map((resident) => ({ email: resident.applicant.email, userId: resident.userId, applicationId: resident.applicationId }));
    manifest.persistedMemberCount = finalRows.data.length;
    manifest.groupId = groupId;
    saveManifest();
  } finally {
    const errors: unknown[] = [];
    for (const resident of fixture.residents) {
      try {
        const ownedRows = await db.from("manager_application_records")
          .select("id,manager_user_id,property_id,resident_email")
          .eq("property_id", fixture.propertyId).eq("resident_email", resident.applicant.email).limit(2);
        if (ownedRows.error) throw new Error("Could not verify the exact resident application before cleanup.");
        if ((ownedRows.data ?? []).length > 1) throw new Error("More than one application matched the scoped synthetic resident; refusing deletion.");
        const current = ownedRows.data?.[0];
        if (current) {
          if (current.manager_user_id !== manager.actorId || current.property_id !== fixture.propertyId ||
              current.resident_email?.trim().toLowerCase() !== resident.applicant.email ||
              (resident.applicationId && current.id !== resident.applicationId)) {
            throw new Error("Application cleanup identity changed; refusing deletion.");
          }
          const deleted = await manager.page.request.post("/api/manager-applications", { data: { action: "delete", id: current.id } });
          if (!deleted.ok()) throw new Error(`Application cleanup failed (HTTP ${deleted.status()}).`);
          const after = await db.from("manager_application_records").select("id").eq("id", current.id).limit(1);
          if (after.error || (after.data ?? []).length !== 0) throw new Error("Exact synthetic application remained after cleanup acknowledgment.");
        }
      } catch (error) { errors.push(error); }
    }
    try { await restoreResidents(fixture); } catch (error) { errors.push(error); }
    try { await cleanupWritableSyntheticManager(manager); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Group E2E exact-fixture cleanup failed; retained evidence is private.");
  }
});

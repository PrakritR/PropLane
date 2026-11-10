import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { lstatSync, statSync, realpathSync, openSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";
import { createWritableSyntheticManager } from "../helpers/writable-synthetic-manager";
import { syntheticFixtureActorId } from "../helpers/synthetic-property-e2e";
import { verifySyntheticResidentPhone, type SyntheticPhoneVerification } from "../helpers/synthetic-phone-verification";
import { readCapturedAuthProof, waitForCapturedOutboundMail } from "../helpers/email-onboarding-e2e";

/** Legacy emailed setup handoff. This fixture is not a public guest-application flow. */
test.describe("Legacy resident account setup", () => {
  test.skip(process.env.RESIDENT_SETUP_E2E_ENABLED !== "1", "Requires the isolated DEV no-delivery fixture.");
  test("binds the exact reserved application after real email verification", async ({ browser }) => {
    test.setTimeout(600_000);
    const base = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://invalid");
    const port = Number(base.port);
    if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co" ||
        !process.env.SUPABASE_SERVICE_ROLE_KEY || base.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(base.hostname) || port < 3000 || port > 3014 || !Number.isInteger(port)) {
      throw new Error("Legacy setup fixture requires the exact DEV database and localhost.");
    }
    const dir = process.env.E2E_PRIVATE_FIXTURE_DIR;
    if (!dir || !path.isAbsolute(dir)) throw new Error("Private capture directory required.");
    const stat = lstatSync(dir);
    const followed = statSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir || followed.dev !== stat.dev || followed.ino !== stat.ino || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Capture directory must be private.");
    const stamp = Date.now();
    const email = `e2e-applicant-${stamp}@example.invalid`;
    const appId = `PROPLANE-E2E-LEGACY-${randomUUID()}`;
    const phone = "+12065550142";
    const manifestPath = path.join(dir, `legacy-setup-${randomUUID()}.json`);
    const fd = openSync(manifestPath, "wx", 0o600);
    const manifest: Record<string, unknown> = { email, appId, retained: true, state: "reserved" };
    const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    try { writeFileSync(fd, JSON.stringify(manifest)); } finally { closeSync(fd); }
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const existing = await db.from("manager_application_records").select("id").eq("resident_email", email).limit(2);
    if (existing.error || existing.data?.length) throw new Error("Synthetic mailbox is not an empty application scope.");
    for (let page = 1; ; page += 1) {
      const users = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (users.error) throw new Error("Could not reserve synthetic mailbox.");
      if (users.data.users.some((u) => u.email?.toLowerCase() === email)) throw new Error("Synthetic mailbox already exists.");
      if (users.data.users.length < 1000) break;
      if (page >= 100) throw new Error("Synthetic mailbox reservation exceeded its bound.");
    }
    const manager = await createWritableSyntheticManager(browser);
    const residentContext = await browser.newContext({ baseURL: base.origin, storageState: { cookies: [], origins: [] } });
    const resident = await residentContext.newPage();
    let phoneFixture: SyntheticPhoneVerification | null = null;
    try {
      Object.assign(manifest, { ownerId: manager.actorId, propertyId: manager.property.id, propertyName: manager.property.name, state: "manager-created" }); save();
      const row = { id: appId, name: "E2E Legacy Resident", email, managerUserId: manager.actorId, propertyId: manager.property.id,
        property: manager.property.name, stage: "Submitted", bucket: "pending", detail: "Synthetic legacy setup fixture",
        manualResidentDetails: { phone }, residentUserId: null };
      const created = await manager.page.request.post("/api/manager-applications", { data: { action: "upsert", row } });
      if (!created.ok()) throw new Error(`Synthetic application creation failed (${created.status()}).`);
      const records = await db.from("manager_application_records").select("id,manager_user_id,property_id,resident_email,updated_at,row_data").eq("resident_email", email).limit(2);
      const record = records.data?.[0];
      if (records.error || records.data?.length !== 1 || record?.id !== appId || record.manager_user_id !== manager.actorId || record.property_id !== manager.property.id || record.resident_email !== email) throw new Error("Synthetic application singleton was not confirmed.");
      Object.assign(manifest, { applicationBefore: record, state: "application-created" }); save();
      const resend = await resident.request.post("/api/auth/resident-setup-link", { data: { email } });
      const resendBody = await resend.json() as { ok?: boolean; sent?: boolean };
      if (!resend.ok() || resendBody.ok !== true || resendBody.sent !== true) throw new Error("Legacy setup email was not accepted by the simulated transport.");
      const messages = await waitForCapturedOutboundMail(resident, email);
      const links = messages.flatMap((message) => String(message.payload.text ?? "").match(/https?:\/\/[^\s<>"']+/g) ?? []).map((raw) => { try { return new URL(raw); } catch { return null; } }).filter((url): url is URL => url !== null && url.origin === base.origin && url.pathname === "/auth/resident-setup" && url.searchParams.get("proplane_id") === appId && Boolean(url.searchParams.get("token")));
      if (links.length !== 1) throw new Error("The exact setup capability was not uniquely captured.");
      const setup = links[0]!;
      const stored = await db.from("manager_application_records").select("row_data").eq("id", appId).eq("manager_user_id", manager.actorId).single();
      const data = stored.data?.row_data as { setupTokenHash?: unknown; setupTokenExpiresAt?: unknown } | undefined;
      if (stored.error || typeof data?.setupTokenHash !== "string" || typeof data.setupTokenExpiresAt !== "string") throw new Error("Setup token persistence was not confirmed.");
      await resident.goto(setup.toString());
      const emailInput = resident.locator("#resident-setup-email");
      await expect(emailInput).toHaveValue(email);
      await expect(emailInput).toHaveAttribute("readonly", "");
      const start = resident.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/email-onboarding/start");
      await resident.getByRole("button", { name: "Email verification link" }).click();
      const started = await start;
      const request = started.request().postDataJSON() as { email?: string; applicationId?: string; setupToken?: string };
      if (!started.ok() || request.email !== email || request.applicationId !== appId || request.setupToken !== setup.searchParams.get("token")) throw new Error("Verification request did not preserve the setup capability.");
      await expect(resident.getByRole("status")).toHaveText("If the address can receive a link, check your email to continue.");
      const href = await readCapturedAuthProof(resident, email);
      const clean = await browser.newContext({ baseURL: base.origin, storageState: { cookies: [], origins: [] } });
      const verified = await clean.newPage();
      try {
        const finish = verified.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/email-onboarding/finish", { timeout: 45_000 });
        await verified.goto(href);
        if (!(await finish).ok()) throw new Error("Email handoff failed.");
        await verified.waitForURL((url) => url.pathname.startsWith("/resident") || url.pathname === "/auth/verify-phone", { timeout: 60_000 });
        // Auth confirmation can render a transient resident route before the
        // phone guard redirects. Verify the exact email-confirmed resident
        // actor directly, then navigate to this fixture's exact application.
        phoneFixture = await verifySyntheticResidentPhone(verified, { email, phone });
        await verified.goto(`/resident/applications/pending?open=${encodeURIComponent(appId)}`);
        await expect(verified).toHaveURL(new RegExp(`/resident/applications/pending`));
        await verified.reload();
        await expect(verified.getByText("E2E Legacy Resident", { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
        const bound = await db.from("manager_application_records").select("id,manager_user_id,property_id,resident_email,updated_at,row_data").eq("id", appId).single();
        const boundUserId = (bound.data?.row_data as { residentUserId?: unknown } | undefined)?.residentUserId;
        const browserUserId = await syntheticFixtureActorId(verified);
        if (bound.error || bound.data?.manager_user_id !== manager.actorId || bound.data.property_id !== manager.property.id || bound.data.resident_email !== email || typeof boundUserId !== "string" || boundUserId !== browserUserId) throw new Error("The reserved application was not bound to the current resident.");
        const user = await db.auth.admin.getUserById(boundUserId);
        const role = await db.from("profile_roles").select("role").eq("user_id", boundUserId).eq("role", "resident");
        if (user.error || user.data.user?.email !== email || !user.data.user.email_confirmed_at || role.error || role.data?.length !== 1) throw new Error("The bound resident identity was not verified.");
        Object.assign(manifest, { residentId: boundUserId, applicationAfter: { id: bound.data.id, updatedAt: bound.data.updated_at }, state: "bound-retained" }); save();
      } finally {
        try { await phoneFixture?.restore(); } catch (error) {
          Object.assign(manifest, { phoneRestoreFailed: true }); save();
          throw error;
        } finally { await clean.close(); }
      }
    } finally {
      await residentContext.close();
      try { await manager.phoneFixture?.restore(); } catch (error) {
        Object.assign(manifest, { managerPhoneRestoreFailed: true }); save();
        throw error;
      } finally { await manager.context.close(); }
    }
  });
});

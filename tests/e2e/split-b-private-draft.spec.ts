/** Dedicated, reviewed split-B proof only; post-stop cleanup is separate. */
import { test, expect, type BrowserContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { persistSplitBManifest, preflightSplitBDraftOnDev, type SplitBDraftManifest } from "../helpers/split-b-draft-proof";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("verified synthetic free manager saves one private draft", async ({ browser }) => {
  test.skip(process.env.SPLIT_B_DEDICATED_RUNNER !== "1", "Dedicated split-B proof required");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const managerId = process.env.SPLIT_B_MANAGER_ID, workspaceId = process.env.SPLIT_B_WORKSPACE_ID;
  const expectedEmail = process.env.SPLIT_B_EXPECTED_EMAIL, storageStateFile = process.env.SPLIT_B_STORAGE_STATE, dir = process.env.SPLIT_B_PRIVATE_DIR;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !serviceKey || !managerId || !workspaceId ||
    !expectedEmail || !/^get-started-e2e-[0-9]+@example\.invalid$/.test(expectedEmail) || !storageStateFile || !path.isAbsolute(storageStateFile) ||
    !dir || !path.isAbsolute(dir) || path.dirname(storageStateFile) !== dir || (lstatSync(dir).mode & 0o777) !== 0o700 || (lstatSync(storageStateFile).mode & 0o777) !== 0o600) {
    throw new Error("Exact private DEV synthetic fixture required.");
  }
  const phaseAFile = path.join(dir, "status.json");
  const inputFile = path.join(dir, "split-b-input.json");
  const managerManifestFile = path.join(dir, `manager-${createHash("sha256").update(expectedEmail.toLowerCase()).digest("hex")}.manifest.json`);
  for (const file of [phaseAFile, inputFile, managerManifestFile]) {
    if ((lstatSync(file).mode & 0o777) !== 0o600) throw new Error("Private Phase A evidence required.");
  }
  const phaseA = JSON.parse(readFileSync(phaseAFile, "utf8")) as { stage?: string; browserOk?: boolean; serverExited?: boolean; portClosed?: boolean; draftCleanupExit?: number; accountRetained?: boolean; sessionRetained?: boolean };
  const input = JSON.parse(readFileSync(inputFile, "utf8")) as { version?: number; managerId?: string; workspaceId?: string; expectedEmail?: string; storageStateFile?: string; phoneMarker?: string };
  const managerManifest = JSON.parse(readFileSync(managerManifestFile, "utf8")) as { state?: string; authId?: string; email?: string };
  const normalPhaseA = phaseA.stage === "phase_a_complete" && phaseA.browserOk === true && phaseA.serverExited === true && phaseA.portClosed === true;
  const verifiedPrebrowserRetry = process.env.SPLIT_B_VERIFIED_PREBROWSER_RETRY === "1" && phaseA.stage === "phase_b_browser_failed_draft_checked" &&
    phaseA.browserOk === false && phaseA.serverExited === true && phaseA.portClosed === true && phaseA.draftCleanupExit === 0 &&
    phaseA.accountRetained === true && phaseA.sessionRetained === true;
  if ((!normalPhaseA && !verifiedPrebrowserRetry) ||
    input.version !== 1 || input.managerId !== managerId || input.workspaceId !== workspaceId || input.expectedEmail?.toLowerCase() !== expectedEmail.toLowerCase() ||
    path.resolve(input.storageStateFile ?? "") !== storageStateFile || input.phoneMarker !== "synthetic_test_only_no_sms" ||
    managerManifest.state !== "identified" || managerManifest.authId !== managerId || managerManifest.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error("Retained Phase A identity does not match the exact Split B fixture.");
  }
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const context: BrowserContext = await browser.newContext({ storageState: storageStateFile });
  const page = await context.newPage();
  const marker = `split-b-${randomUUID()}`;
  const file = path.join(dir, "split-b-manifest.json");
  let manifest: SplitBDraftManifest | null = null;
  let phase = "authenticate-storage-state";
  const setPhase = (next: string, status?: number) => console.log(`[split-b-e2e] phase=${next} status=${status ?? "not-observed"}`);
  setPhase(phase);
  const state = JSON.parse(readFileSync(storageStateFile, "utf8")) as { cookies?: Array<{ name: string; value: string }> };
  const encoded = (state.cookies ?? []).filter((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name)).map((cookie) => decodeURIComponent(cookie.value)).join("");
  const authJson = encoded.startsWith("base64-") ? Buffer.from(encoded.slice(7), "base64").toString("utf8") : encoded;
  const accessToken = (JSON.parse(authJson) as { access_token?: string }).access_token;
  if (!accessToken) throw new Error("Synthetic manager session unavailable.");
  const auth = await db.auth.getUser(accessToken);
  if (auth.error || auth.data.user?.id !== managerId || !auth.data.user.email_confirmed_at || auth.data.user.email?.toLowerCase() !== expectedEmail.toLowerCase() || auth.data.user.app_metadata?.proplane_email_onboarding !== true) throw new Error("Exact verified synthetic onboarding subject required.");
  const roles = await db.from("profile_roles").select("role").eq("user_id", managerId).order("role");
  if (roles.error || JSON.stringify((roles.data ?? []).map((row) => row.role)) !== JSON.stringify(["manager"])) throw new Error("Stored manager-only role required.");
  const profile = await db.from("profiles").select("phone,phone_verified_at").eq("id", managerId).maybeSingle();
  if (profile.error || !profile.data?.phone || !profile.data.phone_verified_at) throw new Error("Explicit synthetic test phone marker required; no SMS is sent by this proof.");
  const purchase = await db.from("manager_purchases").select("tier,billing,promo_code,stripe_customer_id,stripe_subscription_id,stripe_checkout_session_id,apple_original_transaction_id").eq("user_id", managerId);
  const checkoutSession = purchase.data?.[0]?.stripe_checkout_session_id;
  const internalFreeCheckout = checkoutSession == null || /^axis_intent_[a-f0-9-]+$/i.test(checkoutSession);
  if (purchase.error || purchase.data?.length !== 1 || purchase.data[0]?.tier !== "free" || purchase.data[0]?.billing !== "free" ||
    !internalFreeCheckout || [purchase.data[0]?.promo_code, purchase.data[0]?.stripe_customer_id, purchase.data[0]?.stripe_subscription_id, purchase.data[0]?.apple_original_transaction_id].some((value) => value != null && value !== "")) {
    throw new Error("Exact internally-free, provider-unanchored purchase required.");
  }
  const workspace = await db.from("portal_workspaces").select("id,is_default,is_service,stripe_connect_account_id").eq("id", workspaceId).eq("owner_user_id", managerId).maybeSingle();
  if (workspace.error || workspace.data?.is_default !== true || workspace.data?.is_service !== false || workspace.data?.stripe_connect_account_id != null) throw new Error("Exact owned non-service workspace required.");
  try {
  phase = "preflight-owned-graph"; setPhase(phase);
  const [properties, connections, posts, smsOutbox] = await Promise.all([
    db.from("manager_property_records").select("id").eq("manager_user_id", managerId),
    db.from("listing_channel_connections").select("id").eq("manager_user_id", managerId),
    db.from("listing_channel_posts").select("id").eq("manager_user_id", managerId),
    db.from("sms_outbox").select("id").or(`manager_user_id.eq.${managerId},actor_user_id.eq.${managerId}`),
  ]);
  if (properties.error || connections.error || posts.error || smsOutbox.error || properties.data?.length || connections.data?.length || posts.data?.length || smsOutbox.data?.length) {
    throw new Error("Synthetic property/channel/provider scope changed before the draft phase.");
  }
  phase = "open-properties"; setPhase(phase);
  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  const activeWorkspaceResponse = await page.request.get("/api/workspaces");
  const activeWorkspacePayload = await activeWorkspaceResponse.json() as { activeWorkspaceId?: unknown };
  if (!activeWorkspaceResponse.ok() || activeWorkspacePayload.activeWorkspaceId !== workspaceId) throw new Error("The expected synthetic workspace is not the active portal workspace.");
  await page.route("**/api/property-records", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") { await route.continue(); return; }
    const body = request.postDataJSON() as { action?: unknown; status?: unknown; id?: unknown; managerUserId?: unknown; rowData?: unknown };
    if (manifest || body.status !== "draft" || typeof body.id !== "string" || body.managerUserId !== managerId || !JSON.stringify(body.rowData).includes(marker)) { await route.abort(); return; }
    const candidate: SplitBDraftManifest = { managerId, workspaceId, propertyId: body.id, marker, state: "reserved" };
    await preflightSplitBDraftOnDev(candidate, "absent");
    persistSplitBManifest(file, candidate);
    manifest = candidate;
    await route.continue();
  });
  phase = "open-draft-form"; setPhase(phase);
  await page.locator('[data-attr="manager-properties-add-top"]').click();
  await page.locator('[data-attr="manager-properties-add-property"]').click();
  await page.getByPlaceholder("Magnolia House").fill(marker);
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/property-records" && response.request().postData()?.includes(marker) === true, { timeout: 20000 });
  await page.getByRole("button", { name: /^Close$/ }).click();
  phase = "save-private-draft"; setPhase(phase);
  const response = await saved; setPhase("property-records-post-response", response.status());
  expect(response.ok()).toBeTruthy();
  if (!manifest) throw new Error("Draft request was not captured.");
  const captured: SplitBDraftManifest = manifest;
  const row = await db.from("manager_property_records").select("updated_at").eq("id", captured.propertyId).eq("manager_user_id", managerId).eq("workspace_id", workspaceId).eq("status", "draft").single();
  if (row.error || typeof row.data?.updated_at !== "string") throw new Error("Draft revision unavailable.");
  captured.updatedAt = row.data.updated_at; captured.state = "saved"; persistSplitBManifest(file, captured);
  await preflightSplitBDraftOnDev(captured, "draft");
  phase = "verify-draft-list"; setPhase(phase);
  await page.goto("/portal/properties/drafts");
  await expect(page.getByText(marker).first()).toBeVisible();
  } catch (error) {
    console.error(`[split-b-e2e] failed_phase=${phase} status=not-observed`);
    throw error;
  } finally {
    await context.close();
  }
});

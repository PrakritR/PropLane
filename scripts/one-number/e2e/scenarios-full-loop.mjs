/**
 * full-loop: the whole "Uber for property management" loop by text, in a PropLane-managed (is_service) workspace with a signed
 * fee policy and in a self-serve workspace, against the REAL inbound webhook, the real /l/<token> pages and the real
 * Stripe TEST API (the local key must be sk_test; every payment step is refused otherwise).
 *
 *   node scripts/one-number/e2e-scenarios.mjs --mode per_workspace --only full-loop
 *
 * Per workspace kind (managed on the PropLane line, self-serve on the workspace's own number):
 *   (a) a prospect texts for homes near UW -> tour (link or booking) -> apply link opens (HTTP 200) -> after applying, "send me the
 *       application fee link" -> /l/<token> -> code text captured -> code accepted -> the pay page renders -> a TEST embedded
 *       checkout session is created for the exact amount (read back from Stripe)
 *   (b) a resident with a lease: "send me my rent link" -> link -> code -> pay page -> a TEST bank PaymentIntent (managed) / card
 *       session (self-serve) for the exact amount
 *   (c) the resident texts "kitchen sink leaking" + a photo -> a service is filed -> the manager (service manager phone when
 *       managed) gets the approval text -> Y -> the vendor is offered the job (general area only) -> YES -> the address comes only
 *       after accept -> DONE + photo -> the resident is asked if it is fixed -> YES -> INVOICE $180 -> the manager approves ->
 *       managed: vendor payable posted to the vendor's ledger party for $180 and the owner charged; self-serve: a bill for $180
 *   (d) once, on the PropLane line: an unknown vendor texts "any jobs near Ballard?" -> jobs + a sign-up link
 *   (e) once: "Hey I want to sign up as a manager" -> code echo -> account -> the one-tap link signs in (HTTP + session cookie)
 * Every text any party receives passes the hygiene checks: no markdown, no long dashes, plain GSM-7, links on their own line,
 * canonical host.
 */
import { createHash, randomBytes } from "node:crypto";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { hex, sleep } from "./core.mjs";
import { ensureServiceLine, enterPerWorkspace, relocate } from "./scenarios-svcline.mjs";

const NOW = () => new Date().toISOString();
const last10 = (p) => String(p).replace(/\D/g, "").slice(-10);
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const urlsOf = (text) => [...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
const HOST_OK = /^(www\.)?proplane\.ai$|^localhost$|^127\.0\.0\.1$/i;
const LONG_DASH = /[–—]/;
const NON_GSM = /[^\x20-\x7E\n]/;
const MARKDOWN = [/\*\*[^*\n]+\*\*/, /`[^`\n]+`/, /^\s{0,3}#{1,6}\s/m, /\[[^\]\n]+\]\(https?:/, /(^|\s)__[^_\n]+__(\s|$)/, /^\s*\*\s+\S/m];

/**
 * The visible text of a page we just fetched: script bodies dropped, then tags, then runs of space.
 * Script bodies go by a literal scan rather than a `<script>...</script>` regex - such a pattern
 * silently misses `<SCRIPT>`, `</script >` and `</script foo>`, so a JSON payload inside a script
 * would leak into the text an assertion below reads (and CodeQL's js/bad-tag-filter flags it).
 */
function visibleText(html) {
  const source = String(html);
  const lower = source.toLowerCase();
  let out = "";
  let cursor = 0;
  for (;;) {
    const open = lower.indexOf("<script", cursor);
    if (open < 0) break;
    const openEnd = source.indexOf(">", open);
    if (openEnd < 0) break;
    out += `${source.slice(cursor, open)} `;
    const close = lower.indexOf("</script", openEnd);
    const closeEnd = close < 0 ? -1 : source.indexOf(">", close);
    if (closeEnd < 0) {
      cursor = source.length;
      break;
    }
    cursor = closeEnd + 1;
  }
  out += source.slice(cursor);
  return out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Every text any party got must read like a text: no markdown, no long dashes, plain GSM-7, links alone on a line, canonical host. */
function hygiene(ctx, label, bodies) {
  const { check } = ctx;
  const problems = [];
  for (const body of bodies) {
    const text = String(body);
    if (LONG_DASH.test(text)) problems.push(`long dash: ${text.slice(0, 120)}`);
    if (NON_GSM.test(text)) problems.push(`non-GSM-7 ${JSON.stringify(text.match(NON_GSM))}: ${text.slice(0, 120)}`);
    for (const re of MARKDOWN) if (re.test(text)) problems.push(`markdown ${re}: ${text.slice(0, 120)}`);
    if (/work order/i.test(text)) problems.push(`says work order: ${text.slice(0, 120)}`);
    for (const url of urlsOf(text)) {
      let host = "";
      try { host = new URL(url).hostname; } catch { /* below */ }
      if (!HOST_OK.test(host)) problems.push(`non-canonical host ${url}`);
      const alone = text.split("\n").some((line) => line.trim() === url || line.trim().replace(/[.,;:!?]+$/, "") === url);
      if (!alone) problems.push(`link not on its own line: ${url} in ${text.slice(0, 160)}`);
    }
  }
  check(`${label}: ${bodies.length} text(s) pass hygiene (no markdown, no long dash, GSM-7, links on their own line, canonical host)`, problems.length === 0, problems.join("\n"));
}

/** A headless Chromium from the repo's playwright; null (and a note) when none can start. */
async function inBrowser(note, fn) {
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    return await fn(browser);
  } catch (error) {
    note(`(no browser: ${error instanceof Error ? error.message.split("\n")[0] : error})`);
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function stripeOrNull(env) {
  const key = String(env.STRIPE_SECRET_KEY ?? "");
  return key.startsWith("sk_test_") ? new Stripe(key) : null;
}

/** Drive a phone-bound /l/<token> link: code gate -> code text -> verify -> pay page -> TEST checkout/PaymentIntent read back from Stripe. */
async function payLinkFlow(ctx, { label, url, phone, chargeId, title, amountCents, method }) {
  const { h, check, note } = ctx;
  const stripe = stripeOrNull(h.env);
  const token = (/\/l\/([A-Za-z0-9_-]{32,})/.exec(url) ?? [])[1];
  check(`${label}: the link is a phone-bound /l/<token>`, Boolean(token), url);
  if (!token) return null;
  const path = new URL(url).pathname;
  const gate = await fetch(`${h.base}${path}`, { redirect: "manual" });
  const gateHtml = await gate.text();
  check(`${label}: the link opens (HTTP 200) on the code gate, not the charge`, gate.status === 200 && /code/i.test(gateHtml) && !gateHtml.includes(title), `${gate.status}`);
  const mark = h.captureMark();
  const send = await fetch(`${h.base}/api/l/${token}/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send" }) });
  check(`${label}: the code request is accepted`, send.status === 200, `${send.status} ${await send.text()}`);
  await sleep(1500);
  const codeText = h.captured(mark).filter((m) => last10(m.to) === last10(phone)).map((m) => m.body).find((b) => /\b\d{6}\b is your PropLane code/.test(b));
  check(`${label}: the code text was captured, to the link's own phone`, Boolean(codeText), JSON.stringify(h.captured(mark).map((m) => [m.to, m.body])));
  if (!codeText) return null;
  hygiene(ctx, `${label} code text`, [codeText]);
  note(`< (code text) ${codeText}`);
  const code = /\b(\d{6})\b/.exec(codeText)[1];
  const wrong = await fetch(`${h.base}/api/l/${token}/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", code: code === "000000" ? "111111" : "000000" }) });
  check(`${label}: a wrong code is refused`, wrong.status !== 200, String(wrong.status));
  const verify = await fetch(`${h.base}/api/l/${token}/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", code }) });
  const cookie = (verify.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check(`${label}: the right code is accepted and opens a session`, verify.status === 200 && /^pbl_/.test(cookie), `${verify.status} ${cookie}`);
  const page = await fetch(`${h.base}${path}`, { headers: { cookie }, redirect: "manual" });
  const html = await page.text();
  const text = visibleText(html);
  const dollars = `$${(amountCents / 100).toFixed(2)}`;
  check(`${label}: the embedded payment page renders (HTTP 200) with the charge, the exact amount and the Pay button`, page.status === 200 && text.includes(title) && text.includes(dollars) && /phone-link-pay/.test(html), `${page.status} ${text.slice(0, 300)}`);
  if (!stripe) { check(`${label}: the local Stripe key is a test key`, false, "STRIPE_SECRET_KEY is not sk_test"); return { token, cookie }; }

  const checkout = await fetch(`${h.base}/api/l/${token}/rent-checkout`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(method === "bank" ? { method: "bank" } : {}) });
  const body = await checkout.json().catch(() => ({}));
  let sessionId = null;
  if (method === "bank") {
    const piId = body?.bank?.paymentIntentId;
    check(`${label}: a bank PaymentIntent is created (TEST)`, checkout.status === 200 && /^pi_/.test(piId ?? ""), `${checkout.status} ${JSON.stringify(body).slice(0, 300)}`);
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId);
      check(`${label}: Stripe has the PaymentIntent, test mode, not paid, for the charge`, pi.livemode === false && pi.amount >= amountCents && pi.status !== "succeeded" && String(pi.metadata?.charge_ids ?? pi.metadata?.charge_id ?? "").includes(chargeId), `${pi.status} ${pi.amount} ${JSON.stringify(pi.metadata)}`);
    }
  } else {
    const secret = body?.clientSecret ?? "";
    check(`${label}: an embedded checkout session is created (TEST)`, checkout.status === 200 && /_secret_/.test(secret), `${checkout.status} ${JSON.stringify(body).slice(0, 300)}`);
    if (secret) {
      sessionId = secret.split("_secret_")[0];
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      check(`${label}: Stripe has the session, test mode, open and unpaid, for the charge`, session.livemode === false && session.status === "open" && session.payment_status === "unpaid" && String(session.metadata?.charge_ids ?? "").includes(chargeId), `${session.status} ${session.payment_status} ${JSON.stringify(session.metadata)}`);
      check(`${label}: the session total covers the exact amount (${dollars}) plus only the processing fee`, session.amount_total >= amountCents && session.amount_total <= amountCents + Math.ceil(amountCents * 0.06) + 100, `${session.amount_total} vs ${amountCents}`);
    }
  }
  return { token, cookie, sessionId };
}

/**
 * Really pay a card checkout in Stripe TEST mode: open the phone-bound page in headless Chromium with the verified link session, click Pay,
 * fill Stripe's embedded form with the 4242 test card, wait for Stripe to report the session paid, then hand the local webhook the
 * `checkout.session.completed` event Stripe recorded (signed with the test webhook secret; Stripe cannot reach localhost) and assert
 * the charge is paid. Skipped, with a note, when no browser can start.
 */
async function payCardInBrowserAndSettle(ctx, { label, token, cookie, sessionId, chargeId }) {
  const { h, db, check, note } = ctx;
  const stripe = stripeOrNull(h.env);
  if (!stripe || !sessionId) return;
  const outcome = await inBrowser(note, async (browser) => {
    const context = await browser.newContext();
    await context.addCookies(cookie.split("; ").filter(Boolean).map((c) => { const i = c.indexOf("="); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.base }; }));
    const page = await context.newPage();
    await page.goto(`${h.base}/l/${token}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.click('[data-attr="phone-link-pay"]', { timeout: 30_000 });
    // Stripe's embedded form lives in a cross-origin iframe; find the frame that holds the card field.
    const deadline = Date.now() + 90_000;
    let frame = null;
    while (Date.now() < deadline && !frame) {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        if (await f.locator("#cardNumber").count().catch(() => 0)) { frame = f; break; }
      }
      if (!frame) await page.waitForTimeout(1000);
    }
    if (!frame) return { error: "no Stripe card field appeared" };
    // Typed key by key: Stripe's card fields format and validate on real key events, a bare fill leaves them empty.
    for (const [selector, value] of [["#cardNumber", "4242424242424242"], ["#cardExpiry", "1234"], ["#cardCvc", "123"]]) {
      await frame.locator(selector).click();
      await frame.locator(selector).pressSequentially(value, { delay: 60 });
    }
    if (await frame.locator("#billingName").count()) { await frame.locator("#billingName").click(); await frame.locator("#billingName").fill("Sky Resident"); }
    if (await frame.locator("#billingPostalCode").count()) { await frame.locator("#billingPostalCode").click(); await frame.locator("#billingPostalCode").pressSequentially("98105", { delay: 60 }); }
    const submit = frame.locator('button[type="submit"], .SubmitButton').first();
    await submit.scrollIntoViewIfNeeded().catch(() => undefined);
    await submit.click({ timeout: 30_000 });
    const until = Date.now() + 120_000;
    for (;;) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === "paid") return { paid: true, paymentIntent: session.payment_intent };
      if (Date.now() > until) {
        const shot = `${h.captureFile.replace(/captured-sms\.jsonl$/, "")}pay-card.png`;
        await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        const text = await frame.locator("body").innerText().catch(() => "");
        return { error: `session still ${session.payment_status}`, screenshot: shot, form: text.replace(/\s+/g, " ").slice(0, 700), url: page.url() };
      }
      await page.waitForTimeout(3000);
    }
  });
  if (!outcome) return;
  check(`${label}: the test card payment completes in Stripe (4242, test mode)`, outcome.paid === true, JSON.stringify(outcome));
  if (!outcome.paid) return;
  const secret = String(h.env.STRIPE_WEBHOOK_SECRET ?? "");
  if (!secret) { check(`${label}: a webhook secret is configured`, false, "STRIPE_WEBHOOK_SECRET missing"); return; }
  let event = null;
  for (let attempt = 0; attempt < 10 && !event; attempt += 1) {
    const list = await stripe.events.list({ type: "checkout.session.completed", limit: 20 });
    event = list.data.find((e) => e.data?.object?.id === sessionId) ?? null;
    if (!event) await sleep(2000);
  }
  check(`${label}: Stripe recorded the checkout.session.completed event`, Boolean(event), "no event for the session");
  if (!event) return;
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload, signal: AbortSignal.timeout(240_000) });
  check(`${label}: the local webhook accepts the signed event (HTTP 200)`, res.status === 200, `${res.status} ${(await res.text()).slice(0, 200)}`);
  let row = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { data } = await db.from("portal_household_charge_records").select("status, row_data").eq("id", chargeId).maybeSingle();
    row = data;
    if (row?.status === "paid") break;
    await sleep(2000);
  }
  check(`${label}: the charge is marked paid`, row?.status === "paid", JSON.stringify({ status: row?.status, bal: row?.row_data?.balanceLabel }));
  const after = await fetch(`${h.base}/l/${token}`, { headers: { cookie }, redirect: "manual" });
  const afterHtml = await after.text();
  const afterText = visibleText(afterHtml);
  check(`${label}: the settled link no longer offers to pay (spent, or 'Payment received')`, !/phone-link-pay/.test(afterHtml) && /Payment received|expired/i.test(afterText), afterText.slice(0, 300));
}

/** A pending application fee for the applicant's own login (what applying creates). */
async function writeApplicationFee({ db, world, applicant, house, managerUserId, amount = 45 }) {
  const id = `hc_e2e_${world.runId}_${hex(6)}_application_fee`;
  const money = `$${amount.toFixed(2)}`;
  const row = {
    id, kind: "application_fee", title: "Application fee", amountLabel: money, balanceLabel: money, status: "pending", createdAt: NOW(), residentVisibleAt: NOW(),
    residentUserId: applicant.id, residentEmail: applicant.email, residentName: "Jordan Prospect", propertyId: house.id, propertyLabel: house.name, managerUserId, testRunId: world.runId,
  };
  const ins = await db.from("portal_household_charge_records").insert({ id, manager_user_id: managerUserId, resident_user_id: applicant.id, resident_email: applicant.email, property_id: house.id, kind: "application_fee", status: "pending", row_data: row });
  if (ins.error) throw new Error(`application fee: ${ins.error.message}`);
  return { id, title: row.title, cents: amount * 100 };
}

async function placeNumber(db, h, { managerId, workspaceId, phone }) {
  const ins = await db.from("manager_sms_numbers").insert({
    manager_user_id: managerId, workspace_id: workspaceId, phone_number: phone, phone_number_sid: `PNe2e${hex(28)}`,
    messaging_service_sid: h.env.TWILIO_MESSAGING_SERVICE_SID ?? `MGe2e${hex(28)}`, campaign_sid: h.env.TWILIO_CAMPAIGN_SID, provider: "twilio", provision_state: "active",
    registration_state: "approved", attachment_state: "attached", number_registration_state: "registered", requested_at: NOW(), provisioned_at: NOW(),
  }).select("id");
  if (ins.error) throw new Error(`number: ${ins.error.message}`);
  return ins.data[0].id;
}

async function ensureFullLoop(h, world) {
  h.fx ??= {};
  return (h.fx.fullLoop ??= (async () => {
    const { db } = world;
    const fx = await ensureServiceLine(h, world);

    // ---- managed: the Brooklyn service home takes tours and has a signed fee policy; the client's own service workspace holds the resident
    await world.paintTourAvailability({ ownerId: fx.owner.id, houseId: fx.brooklyn.id });
    await world.createOwner({ workspaceId: fx.service[0], phone: world.phone(), fullName: "Olive Owner", label: "fl-owner1" });
    const client = await world.createUser({ label: "fl-client", role: "manager", phone: world.phone(), fullName: "Ambika Client" });
    const ws = await db.from("portal_workspaces").insert({ owner_user_id: client.id, name: `E2E 1. LoopClient ${world.runId}`, is_default: true, is_service: true, city: "Seattle" }).select("id");
    if (ws.error) throw new Error(`client workspace: ${ws.error.message}`);
    const clientWs = ws.data[0].id;
    world.workspaceIds.push(clientWs);
    const clientHouse = await world.createHouse({ ownerId: client.id, workspaceId: clientWs, name: `E2E Loop Client House ${world.runId}`, street: "6100 24th Ave NW" });
    const clientLine = world.phone();
    const clientNumberId = await placeNumber(db, h, { managerId: client.id, workspaceId: clientWs, phone: clientLine });
    await world.createOwner({ workspaceId: clientWs, phone: world.phone(), fullName: "Casey Owner", label: "fl-owner2" });
    const mResidentPhone = world.phone();
    const mResident = await world.createResident({ ownerId: client.id, house: clientHouse, roomIndex: 1, label: "fl-mres", phone: mResidentPhone, fullName: "Riley Resident" });
    const rosterVendorPhone = world.phone();
    world.phones.push(rosterVendorPhone);
    const rosterId = `svcv-e2e-${world.runId}-fl`;
    const rosterRow = { id: rosterId, name: "Roster Pat Plumber", trade: "Plumber", trades: ["Plumber"], phone: rosterVendorPhone, email: "", notes: "", active: true,
      serviceRoster: true, dispatchTrades: ["plumber"], serviceArea: "Wedgwood", dispatchAvailable: true, consentBasis: "added_by_admin_prior_relationship", testRunId: world.runId };
    const rv = await db.from("manager_vendor_records").upsert({ id: rosterId, manager_user_id: fx.owner.id, row_data: rosterRow }, { onConflict: "id" });
    if (rv.error) throw new Error(`roster vendor: ${rv.error.message}`);
    const serviceManagerPhone = world.phone();

    // ---- self-serve: a manager with a paid plan, her own number, a house, a resident, a plumber with a PropLane login and an approve-first rule
    const sManagerPhone = world.phone();
    const sManager = await world.createUser({ label: "fl-smgr", role: "manager", phone: sManagerPhone, fullName: "Morgan Manager" });
    const sWs = await world.createWorkspace({ ownerId: sManager.id, name: `E2E Loop Self Serve ${world.runId}` });
    const sHouse = await world.createHouse({ ownerId: sManager.id, workspaceId: sWs, name: `E2E Loop Self House ${world.runId}`, street: "4200 Brooklyn Ave NE" });
    await relocate(db, sHouse, { address: "4200 Brooklyn Ave NE, Seattle, WA 98105", neighborhood: "University District", zip: "98105", lat: 47.66, lng: -122.314 });
    await world.paintTourAvailability({ ownerId: sManager.id, houseId: sHouse.id });
    const sLine = world.phone();
    const sNumberId = await placeNumber(db, h, { managerId: sManager.id, workspaceId: sWs, phone: sLine });
    const sResidentPhone = world.phone();
    const sResident = await world.createResident({ ownerId: sManager.id, house: sHouse, roomIndex: 1, label: "fl-sres", phone: sResidentPhone, fullName: "Sky Resident" });
    const sVendorPhone = world.phone();
    const sVendorUser = await world.createUser({ label: "fl-svendor", role: "vendor", phone: sVendorPhone, fullName: "Pat Plumber" });
    const sVendor = await world.createRosterVendor({ ownerId: sManager.id, name: "Pat Plumber", trade: "Plumber", phone: sVendorPhone });
    const link = await db.from("manager_vendor_records").update({ vendor_user_id: sVendorUser.id }).eq("id", sVendor.id);
    if (link.error) throw new Error(`vendor login link: ${link.error.message}`);
    await world.createDispatchRule({ workspaceId: sWs, ownerId: sManager.id, trade: "plumber", issue: null, vendors: [sVendor], payCents: 15000, nteCents: 25000 });

    // ---- the open job board for the unknown vendor
    {
      const id = `e2e-svc-${world.runId}-fl-pub`;
      const row = { id, title: "Kitchen sink leak at 5400 22nd Ave NW", description: "Slow leak.", category: "plumbing", propertyName: "E2E Ballard House", propertyAddress: "5400 22nd Ave NW, Seattle, WA 98107", unit: "2",
        status: "Open", bucket: "pending", published: true, publishRef: `e2erefpub${world.runId}`, publishBudgetCents: 25000, residentName: "SECRET E2E RESIDENT", testRunId: world.runId };
      const up = await db.from("portal_work_order_records").upsert({ id, manager_user_id: fx.owner.id, row_data: row }, { onConflict: "id" });
      if (up.error) throw new Error(`job board: ${up.error.message}`);
    }
    return {
      fx, serviceManagerPhone,
      managed: { client, workspaceId: clientWs, house: clientHouse, line: clientLine, numberId: clientNumberId, resident: mResident, residentPhone: mResidentPhone, vendorId: rosterId, vendorPhone: rosterVendorPhone, managerPhone: serviceManagerPhone },
      self: { manager: sManager, workspaceId: sWs, house: sHouse, line: sLine, numberId: sNumberId, resident: sResident, residentPhone: sResidentPhone, vendorId: sVendor.id, vendorPhone: sVendorPhone, vendorUser: sVendorUser, managerPhone: sManagerPhone },
    };
  })());
}

export const FULL_LOOP_SCENARIOS = [
  {
    id: "full-loop",
    modes: ["per_workspace"],
    title: "Full loop by text: prospect -> tour -> apply -> fee link -> rent link -> service -> vendor -> invoice -> ledger/bill; vendor jobs; manager sign-up (managed and self-serve)",
    async setup(h, world) {
      h.fx ??= {};
      h.fx.svcReady = ensureServiceLine(h, world);
      h.fx.flReady = ensureFullLoop(h, world);
      await h.fx.flReady;
    },
    async run(ctx) {
      const { h, world, db, check, note } = ctx;
      const fl = await h.fx.flReady;
      const { fx } = fl;
      const restorePerWorkspace = await enterPerWorkspace(db, fx);
      const { data: capBefore } = await db.from("sms_runtime_config").select("campaign_daily_segment_limit, pilot_manager_user_ids").eq("singleton", true).maybeSingle();
      const pilotBefore = capBefore?.pilot_manager_user_ids ?? [];
      await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: Math.max(Number(capBefore?.campaign_daily_segment_limit ?? 500), 5000), pilot_manager_user_ids: [...new Set([...pilotBefore, fx.owner.id, fl.managed.client.id, fl.self.manager.id])] }).eq("singleton", true);
      const { data: settingsBefore } = await db.from("platform_service_settings").select("manager_phone_e164, manager_phone_verified_at").eq("singleton", true).maybeSingle();
      const setManager = await db.from("platform_service_settings").update({ manager_phone_e164: fl.serviceManagerPhone, manager_phone_verified_at: NOW() }).eq("singleton", true);
      if (setManager.error) throw new Error(`manager phone: ${setManager.error.message}`);
      const restore = async () => {
        await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: capBefore?.campaign_daily_segment_limit ?? 500, pilot_manager_user_ids: pilotBefore }).eq("singleton", true);
        await db.from("platform_service_settings").update({ manager_phone_e164: settingsBefore?.manager_phone_e164 ?? null, manager_phone_verified_at: settingsBefore?.manager_phone_verified_at ?? null }).eq("singleton", true);
        await db.from("manager_sms_numbers").delete().in("id", [fl.managed.numberId, fl.self.numberId]);
        await restorePerWorkspace();
      };

      const transcript = [];
      const latencies = [];
      const toPhone = (phone, from = 0) => h.captured(from).filter((m) => last10(m.to) === last10(phone));
      const say = async (who, from, to, body, opts = {}) => {
        let r = await h.text({ from, to, body, media: opts.media ?? [], quietMs: opts.quietMs ?? 9000, maxMs: 180_000 });
        for (let retry = 0; retry < 2 && /could not finish that request|try again or rephrase/i.test(r.all) && !opts.media?.length; retry += 1) {
          note(`(model connection dropped; sending "${body}" again)`);
          r = await h.text({ from, to, body, media: [], quietMs: opts.quietMs ?? 9000, maxMs: 180_000 });
        }
        transcript.push(`${who}: ${body}${opts.media?.length ? " [+photo]" : ""}`);
        transcript.push(`  -> ${(r.all || "(no reply)").replace(/\n---\n/g, " | ").replace(/\n/g, " / ")}`);
        latencies.push([`${who}: ${body.slice(0, 40)}`, r.firstMs]);
        note(`${who}> ${body}${opts.media?.length ? "  [+photo]" : ""}\n< [${r.status}] (${r.firstMs == null ? "no reply" : `first reply ${(r.firstMs / 1000).toFixed(1)} s`}) ${r.all || "(no reply)"}`);
        hygiene(ctx, `reply to "${body.slice(0, 40)}"`, r.replies);
        return r;
      };
      const waitFor = async (probe, ms = 60_000) => {
        const start = Date.now();
        while (Date.now() - start < ms) {
          const value = await probe();
          if (value) return value;
          await sleep(2500);
        }
        return null;
      };
      const textTo = async (phone, mark, ms = 45_000) => waitFor(async () => { const t = toPhone(phone, mark).map((m) => m.body); return t.length ? t : null; }, ms);

      /** (c) the service loop; `kind` is "managed" or "self". */
      async function serviceLoop(kind) {
        const v = fl[kind];
        const managed = kind === "managed";
        const L = `${kind} service`;
        const ownerId = managed ? v.client.id : v.manager.id;
        const filed = async () => ((await db.from("portal_work_order_records").select("id, row_data, vendor_user_id").eq("manager_user_id", ownerId).eq("resident_email", v.resident.email)).data ?? []);
        let r = await say(`${kind} resident`, v.residentPhone, v.line, "kitchen sink leaking", { media: [{ url: h.mediaUrl("leak"), type: "image/png" }] });
        const answers = ["Clean water, nothing electrical nearby, and I already closed the shutoff valve under the sink. Please file it now.", "Yes they can enter if I am not home, any time works. Please file it."];
        for (let step = 0, next = 0; step < 6 && (await filed()).length === 0; step += 1) {
          if (/reply yes to confirm/i.test(r.all)) r = await say(`${kind} resident`, v.residentPhone, v.line, "YES");
          else r = await say(`${kind} resident`, v.residentPhone, v.line, answers[Math.min(next++, answers.length - 1)]);
        }
        const orders = await filed();
        check(`${L}: the resident's leak is filed as one service in the right workspace`, orders.length === 1, JSON.stringify(orders.map((o) => o.id)));
        if (orders.length !== 1) return;
        check(`${L}: the photo rides along on the service`, Array.isArray(orders[0].row_data?.photoDataUrls) && orders[0].row_data.photoDataUrls.length >= 1, JSON.stringify(Object.keys(orders[0].row_data ?? {})));
        const run = await waitFor(async () => ((await db.from("vendor_dispatch_runs").select("id, status, handle, workspace_id, owner_user_id, trade").eq("owner_user_id", ownerId)).data ?? [])[0]);
        check(`${L}: a dispatch run exists, waiting on approval`, Boolean(run) && run.status === "awaiting_approval" && run.workspace_id === v.workspaceId, JSON.stringify(run));
        if (!run) return;
        const ask = await textTo(v.managerPhone, 0, 30_000);
        const askText = (ask ?? []).join("\n");
        check(`${L}: the ${managed ? "SERVICE MANAGER phone" : "manager"} got the approval text with the job number`, new RegExp(`#${run.handle}\\b`).test(askText), askText || "(nothing sent)");
        check(`${L}: no vendor is texted before the approval`, toPhone(v.vendorPhone).length === 0, JSON.stringify(toPhone(v.vendorPhone)));
        hygiene(ctx, `${L} approval text`, ask ?? []);

        const vendorMark = h.captureMark();
        const approve = await say(`${kind} manager`, v.managerPhone, managed ? fx.line : v.line, `Y ${run.handle}`);
        check(`${L}: Y approves the job`, /approved/i.test(approve.all), approve.all);
        const offer = ((await textTo(v.vendorPhone, vendorMark, 60_000)) ?? []).join("\n");
        check(`${L}: the vendor is offered the job with the general area only (no street address, no resident contact)`, Boolean(offer) && /plumb|leak|sink/i.test(offer) && !/24th Ave|Brooklyn Ave/i.test(offer) && !/@|\d{3}[-. ]?\d{4}/.test(offer.replace(/#\d+/g, "")), offer || "(no offer sent)");
        hygiene(ctx, `${L} offer`, offer ? [offer] : []);

        const afterMark = h.captureMark();
        const yes = await say(`${kind} vendor`, v.vendorPhone, managed ? fx.line : v.line, "YES");
        check(`${L}: the vendor's YES is accepted`, /(got it|accepted|confirmed|you have|assigned|you're on)/i.test(yes.all), yes.all);
        const accepted = await waitFor(async () => {
          const { data } = await db.from("vendor_dispatch_runs").select("status, accepted_vendor_directory_id").eq("id", run.id).maybeSingle();
          return data?.status === "accepted" ? data : null;
        }, 30_000);
        check(`${L}: the run is accepted by the vendor`, accepted?.accepted_vendor_directory_id === v.vendorId, JSON.stringify(accepted));
        const toVendorAfter = toPhone(v.vendorPhone, afterMark).map((m) => m.body).join("\n");
        check(`${L}: the street address reaches the vendor only after accepting`, /6100 24th Ave|4200 Brooklyn/i.test(toVendorAfter), toVendorAfter || "(nothing after accept)");
        check(`${L}: the service is assigned to the vendor`, (await filed())[0]?.row_data?.vendorId === v.vendorId, JSON.stringify((await filed())[0]?.row_data?.vendorId));

        const residentMark = h.captureMark();
        const done = await say(`${kind} vendor`, v.vendorPhone, managed ? fx.line : v.line, "DONE", { media: [{ url: h.mediaUrl("after1"), type: "image/png" }] });
        check(`${L}: DONE is acknowledged`, done.all.length > 5, done.all);
        const asked = ((await textTo(v.residentPhone, residentMark, 30_000)) ?? []).join("\n");
        check(`${L}: the resident is asked whether it is fixed`, /fixed/i.test(asked), asked || "(nothing sent)");
        check(`${L}: the completion photo is attached to the service`, Array.isArray((await filed())[0]?.row_data?.completionPhotoDataUrls) && (await filed())[0].row_data.completionPhotoDataUrls.length >= 1, JSON.stringify(Object.keys((await filed())[0]?.row_data ?? {})));
        const fixed = await say(`${kind} resident`, v.residentPhone, v.line, "YES");
        check(`${L}: the resident's YES completes the service`, /(glad|great|thank|complete|closed)/i.test(fixed.all), fixed.all);

        const managerMark = h.captureMark();
        const invoice = await say(`${kind} vendor`, v.vendorPhone, managed ? fx.line : v.line, "INVOICE $180");
        const invoiceAsk = ((await textTo(v.managerPhone, managerMark, 45_000)) ?? []).join("\n");
        check(`${L}: the manager is asked to approve the $180 invoice`, /\$180/.test(invoiceAsk) && new RegExp(`#${run.handle}\\b`).test(invoiceAsk), `${invoice.all} || ${invoiceAsk || "(nothing sent)"}`);
        hygiene(ctx, `${L} invoice ask`, invoiceAsk ? [invoiceAsk] : []);
        const approveInvoice = await say(`${kind} manager`, v.managerPhone, managed ? fx.line : v.line, `Y ${run.handle}`);
        check(`${L}: the manager's Y approves the invoice`, /(approved|bill|paid|posted|thanks|got it)/i.test(approveInvoice.all), approveInvoice.all);
        await sleep(2000);
        const cost = (await filed())[0]?.row_data?.vendorCostCents;
        check(`${L}: the service's vendor cost is $180 (18000 cents)`, cost === 18000, String(cost));
        if (managed) {
          const party = `vendor_dir:${v.vendorId}`;
          const { data: lines } = await db.from("party_ledger_lines").select("account, party_id, workspace_id, amount_cents, journal_id").eq("party_id", party);
          const vendorLine = (lines ?? []).find((l) => l.account === "vendor_payable");
          check(`${L}: the vendor payable is posted to the vendor's ledger party for exactly $180`, Boolean(vendorLine) && Math.abs(Number(vendorLine.amount_cents)) === 18000 && vendorLine.workspace_id === v.workspaceId, JSON.stringify(lines));
          if (vendorLine) {
            const { data: journal } = await db.from("party_ledger_lines").select("account, party_id, amount_cents").eq("journal_id", vendorLine.journal_id);
            const sum = (journal ?? []).reduce((a, l) => a + Number(l.amount_cents), 0);
            check(`${L}: the journal balances and also charges the owner $180`, sum === 0 && (journal ?? []).some((l) => l.account === "owner_payable" && Math.abs(Number(l.amount_cents)) === 18000), JSON.stringify(journal));
          }
        } else {
          const { data: bills } = await db.from("manager_bills").select("*").eq("manager_user_id", ownerId);
          const billOk = (bills ?? []).some((b) => [b.amount_cents, b.total_cents].map(Number).includes(18000) || JSON.stringify(b).includes("18000") || JSON.stringify(b).includes("180"));
          check(`${L}: a bill for $180 exists for the manager`, billOk, JSON.stringify(bills));
        }
      }

      try {
        await sleep(1500);
        if (h.env.STRIPE_SECRET_KEY && !String(h.env.STRIPE_SECRET_KEY).startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY is not a sk_test key: refusing to run payment steps");

        // ================================================= (a) managed: prospect on the PropLane line
        {
          const phone = world.phone();
          const key = last10(phone);
          const P = (body, opts) => say("prospect", phone, fx.line, body, opts);
          const homes = await P("hi, any houses near UW campus?");
          check("managed (a): homes near UW are answered from the managed Brooklyn home with its link and a distance", homes.all.includes(`/rent/listings/${fx.brooklyn.id}`) && /\b\d(\.\d)? ?(mi|mile)/i.test(homes.all), homes.all);
          check("managed (a): the first reply is quick (under 45 s)", homes.firstMs != null && homes.firstMs < 45000, String(homes.firstMs));
          const tour = await P("can I tour the home at 5257 Brooklyn Ave NE on Thursday?");
          const tourLink = urlsOf(tour.all).find((u) => /tour|\/l\//.test(u));
          check("managed (a): a tour slot is offered or a tour link is given", /thu|\d(:\d\d)? ?(am|pm)/i.test(tour.all) || Boolean(tourLink), tour.all);
          let booked = tour;
          if (!/(booked|you.?re all set|confirmed|see you)/i.test(booked.all)) {
            const named = await P("Jordan Prospect, 9am works");
            booked = /confirm|reply yes|\byes\b/i.test(named.all) ? await P("yes") : named;
          }
          const { data: bookings } = await db.from("prospect_tour_bookings").select("id, status").eq("manager_user_id", fx.owner.id);
          const link = urlsOf(booked.all).find((u) => /tour|\/l\//.test(u)) ?? tourLink;
          check("managed (a): the tour is booked (a booking row) or a working tour link was given", (bookings ?? []).length >= 1 || Boolean(link), `${booked.all} | ${JSON.stringify(bookings)}`);
          if (link && (bookings ?? []).length === 0) {
            const res = await fetch(`${h.base}${new URL(link).pathname}${new URL(link).search}`, { redirect: "follow" });
            check("managed (a): the tour link opens (HTTP 200)", res.status === 200, String(res.status));
          }
          const apply = await P("how do I apply for the Brooklyn home?");
          const applyUrl = urlsOf(apply.all).find((u) => /apply|\/l\//.test(u));
          check("managed (a): an apply link is in the reply", Boolean(applyUrl), apply.all);
          if (applyUrl) {
            const res = await fetch(`${h.base}${new URL(applyUrl).pathname}${new URL(applyUrl).search}`, { redirect: "follow" });
            check("managed (a): the apply link opens (HTTP 200)", res.status === 200, `${res.status} ${res.url}`);
          }
          // Applying creates the applicant's login (their verified phone) and the application fee charge.
          const applicant = await world.createApplicant({ ownerId: fx.owner.id, house: fx.brooklyn, phone, label: "fl-applicant" });
          const fee = await writeApplicationFee({ db, world, applicant, house: fx.brooklyn, managerUserId: fx.owner.id });
          const link2 = await P("send me the application fee payment link");
          const url = urlsOf(link2.all).find((u) => /\/l\/[A-Za-z0-9_-]{32,}/.test(u));
          check("managed (a): the reply carries the phone-bound /l/<token> pay link, names the $45 fee and the code step", Boolean(url) && /\$\s?45/.test(link2.all) && /code/i.test(link2.all) && !/checkout\.stripe\.com/i.test(link2.all), link2.all);
          const { data: rows } = await db.from("phone_bound_links").select("purpose, target_id, requires_otp, revoked_at").eq("phone_key", key);
          check("managed (a): one live rent link on the fee charge, code required", (rows ?? []).filter((x) => !x.revoked_at).length === 1 && rows.some((x) => x.purpose === "rent" && x.target_id === fee.id && x.requires_otp), JSON.stringify(rows));
          if (url) await payLinkFlow(ctx, { label: "managed (a) fee link", url, phone, chargeId: fee.id, title: fee.title, amountCents: fee.cents, method: "card" });
        }

        // ================================================= (b) managed: resident rent link
        {
          const v = fl.managed;
          const pay = await say("managed resident", v.residentPhone, v.line, "send me my rent link");
          const url = urlsOf(pay.all).find((u) => /\/l\/[A-Za-z0-9_-]{32,}/.test(u));
          check("managed (b): the reply carries a /l/<token> rent link and names the code step", Boolean(url) && /code/i.test(pay.all), pay.all);
          if (url) await payLinkFlow(ctx, { label: "managed (b) rent link", url, phone: v.residentPhone, chargeId: v.resident.charges[0].id, title: v.resident.charges[0].title, amountCents: 100000, method: "bank" });
        }

        // ================================================= (c) managed: service loop
        await serviceLoop("managed");

        // ================================================= (d) unknown vendor
        {
          const phone = world.phone();
          const jobs = await say("unknown vendor", phone, fx.line, "any jobs near Ballard?");
          check("managed (d): jobs near Ballard are listed", /1\. Plumbing, Ballard/.test(jobs.all), jobs.all);
          check("managed (d): one vendor sign-up link, no street, no resident", (jobs.all.match(/\/start\//g) ?? []).length === 1 && !/22nd Ave|SECRET/i.test(jobs.all), jobs.all);
          const lead = (await db.from("sms_vendor_leads").select("status").eq("phone_key", last10(phone))).data ?? [];
          check("managed (d): one pending vendor lead", lead.length === 1 && lead[0].status === "pending", JSON.stringify(lead));
          const startUrl = urlsOf(jobs.all).find((u) => /\/start\//.test(u));
          if (startUrl) {
            const res = await fetch(`${h.base}${new URL(startUrl).pathname}`, { redirect: "follow" });
            check("managed (d): the sign-up link opens (HTTP 200)", res.status === 200, String(res.status));
          }
        }

        // ================================================= (e) manager sign-up by text
        {
          const phone = world.phone();
          const first = await say("new manager", phone, fx.line, "Hey I want to sign up as a manager");
          check("sign-up: the manager flow starts", /property manager account/i.test(first.all) && /full name/i.test(first.all), first.all);
          await say("new manager", phone, fx.line, "Jane Loop");
          await say("new manager", phone, fx.line, "Loop Rentals");
          await say("new manager", phone, fx.line, "12");
          const toCode = await say("new manager", phone, fx.line, "jane.loop@example.com");
          const code = /code: (\d{6})/.exec(toCode.all)?.[1] ?? "";
          check("sign-up: the code echo is texted", /^\d{6}$/.test(code), toCode.all);
          const done = await say("new manager", phone, fx.line, code);
          const tokenHash = /token_hash=([^&\s]+)/.exec(done.all)?.[1];
          check("sign-up: 'You're set' with the one-tap link", /You're set, Jane/.test(done.all) && Boolean(tokenHash), done.all);
          const { data: prof } = await db.from("profiles").select("id, role, phone, phone_verified_at").eq("phone", phone);
          if (prof?.[0] && !world.userIds.includes(prof[0].id)) {
            world.userIds.push(prof[0].id);
            const { data: wss } = await db.from("portal_workspaces").select("id").eq("owner_user_id", prof[0].id);
            for (const w of wss ?? []) world.workspaceIds.push(w.id);
          }
          check("sign-up: the account exists with the proven phone", prof?.length === 1 && Boolean(prof[0].phone_verified_at), JSON.stringify(prof));
          const linkUrl = urlsOf(done.all).find((u) => /auth\/confirm/.test(u));
          if (linkUrl) {
            const path = `${new URL(linkUrl).pathname}${new URL(linkUrl).search}`;
            const page = await fetch(`${h.base}${path}`, { redirect: "manual" });
            check("sign-up: the one-tap link opens (HTTP 200)", page.status === 200, String(page.status));
            const session = await inBrowser(note, async (browser) => {
              const ctxb = await browser.newContext();
              const pg = await ctxb.newPage();
              await pg.goto(`${h.base}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
              await pg.waitForURL((u) => !u.pathname.startsWith("/auth/confirm"), { timeout: 60_000 }).catch(() => undefined);
              await pg.waitForLoadState("domcontentloaded").catch(() => undefined);
              const cookies = await ctxb.cookies();
              const out = { url: pg.url(), cookie: cookies.some((c) => /^sb-.*auth-token/.test(c.name)) };
              await ctxb.close();
              return out;
            });
            if (session) check("sign-up: the one-tap link signs the new manager in (session cookie, left the confirm page)", session.cookie && !new URL(session.url).pathname.startsWith("/auth/confirm") && !/sign-in|invalid/i.test(session.url), JSON.stringify(session));
            else {
              const tokenHashNow = decodeURIComponent(tokenHash ?? "");
              const anon = createClient(h.env.NEXT_PUBLIC_SUPABASE_URL, h.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
              const ok = await anon.auth.verifyOtp({ token_hash: tokenHashNow, type: "magiclink" });
              check("sign-up: the one-tap token signs in as the new account (no browser available)", !ok.error && ok.data?.user?.id === prof?.[0]?.id, JSON.stringify(ok.error ?? ok.data?.user?.id));
            }
          } else check("sign-up: the reply carries an /auth/confirm link", false, done.all);
        }

        // ================================================= self-serve: the same loop on the workspace's own number
        {
          const v = fl.self;
          const phone = world.phone();
          const P = (body, opts) => say("prospect (self-serve)", phone, v.line, body, opts);
          const homes = await P("hi, any houses near UW campus?");
          check("self-serve (a): homes are answered with the workspace home's link", homes.all.includes(`/rent/listings/${v.house.id}`), homes.all);
          const tour = await P("can I tour the home at 4200 Brooklyn Ave NE on Thursday?");
          check("self-serve (a): a tour slot is offered or a tour link is given", /thu|\d(:\d\d)? ?(am|pm)/i.test(tour.all) || urlsOf(tour.all).some((u) => /tour|\/l\//.test(u)), tour.all);
          let booked = tour;
          if (!/(booked|you.?re all set|confirmed|see you)/i.test(booked.all)) {
            const named = await P("Jordan Prospect, 9am works");
            booked = /confirm|reply yes|\byes\b/i.test(named.all) ? await P("yes") : named;
          }
          const { data: bookings } = await db.from("prospect_tour_bookings").select("id").eq("manager_user_id", v.manager.id);
          check("self-serve (a): the tour is booked (a booking row) or a tour link was given", (bookings ?? []).length >= 1 || urlsOf(booked.all).some((u) => /tour|\/l\//.test(u)), booked.all);
          const apply = await P("how do I apply for it?");
          const applyUrl = urlsOf(apply.all).find((u) => /apply|\/l\//.test(u));
          check("self-serve (a): an apply link is in the reply", Boolean(applyUrl), apply.all);
          if (applyUrl) {
            const res = await fetch(`${h.base}${new URL(applyUrl).pathname}${new URL(applyUrl).search}`, { redirect: "follow" });
            check("self-serve (a): the apply link opens (HTTP 200)", res.status === 200, `${res.status} ${res.url}`);
          }
          const applicant = await world.createApplicant({ ownerId: v.manager.id, house: v.house, phone, label: "fl-applicant2" });
          const fee = await writeApplicationFee({ db, world, applicant, house: v.house, managerUserId: v.manager.id });
          const link2 = await P("send me the application fee payment link");
          const url = urlsOf(link2.all).find((u) => /\/l\/[A-Za-z0-9_-]{32,}/.test(u));
          check("self-serve (a): the reply carries the /l/<token> pay link, names the $45 fee and the code step", Boolean(url) && /\$\s?45/.test(link2.all) && /code/i.test(link2.all), link2.all);
          if (url) await payLinkFlow(ctx, { label: "self-serve (a) fee link", url, phone, chargeId: fee.id, title: fee.title, amountCents: fee.cents, method: "card" });

          const pay = await say("self-serve resident", v.residentPhone, v.line, "send me my rent link");
          const rentUrl = urlsOf(pay.all).find((u) => /\/l\/[A-Za-z0-9_-]{32,}/.test(u));
          check("self-serve (b): the reply carries a /l/<token> rent link and names the code step", Boolean(rentUrl) && /code/i.test(pay.all), pay.all);
          if (rentUrl) {
            const flow = await payLinkFlow(ctx, { label: "self-serve (b) rent link", url: rentUrl, phone: v.residentPhone, chargeId: v.resident.charges[0].id, title: v.resident.charges[0].title, amountCents: 100000, method: "card" });
            if (flow?.sessionId) await payCardInBrowserAndSettle(ctx, { label: "self-serve (b) rent payment", token: flow.token, cookie: flow.cookie, sessionId: flow.sessionId, chargeId: v.resident.charges[0].id });
          }
          await serviceLoop("self");
        }

        const slow = latencies.filter(([, ms]) => ms == null || ms > 45000);
        check("every text was answered, first reply under 45 s", slow.length === 0, JSON.stringify(slow));
        note(`first-reply latency (ms):\n${latencies.map(([t, ms]) => `  ${t} = ${ms}`).join("\n")}`);
        note(`TRANSCRIPT\n${transcript.join("\n")}`);
      } finally {
        await restore();
      }
    },
  },
];

FULL_LOOP_SCENARIOS.push({
  id: "pay-card",
  modes: ["per_workspace"],
  title: "A card payment for real in Stripe TEST mode: phone-bound link -> code -> embedded form -> 4242 card -> signed checkout.session.completed -> charge paid",
  async setup(h, world) {
    h.fx ??= {};
    h.fx.svcReady = ensureServiceLine(h, world);
    h.fx.flReady = ensureFullLoop(h, world);
    await h.fx.flReady;
  },
  async run(ctx) {
    const { h, db, check, world } = ctx;
    const fl = await h.fx.flReady;
    const v = fl.self;
    const restorePerWorkspace = await enterPerWorkspace(db, fl.fx);
    const { data: capBefore } = await db.from("sms_runtime_config").select("campaign_daily_segment_limit, pilot_manager_user_ids").eq("singleton", true).maybeSingle();
    const pilotBefore = capBefore?.pilot_manager_user_ids ?? [];
    await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: Math.max(Number(capBefore?.campaign_daily_segment_limit ?? 500), 5000), pilot_manager_user_ids: [...new Set([...pilotBefore, v.manager.id])] }).eq("singleton", true);
    try {
      await sleep(1500);
      const token = randomBytes(32).toString("base64url");
      const charge = v.resident.charges[0];
      const ins = await db.from("phone_bound_links").insert({
        token_hash: createHash("sha256").update(token, "utf8").digest("hex"), phone_key: last10(v.residentPhone), workspace_id: v.workspaceId, purpose: "rent",
        target_type: "charge", target_id: charge.id, requires_otp: true, expires_at: new Date(Date.now() + 10 * 86400000).toISOString(), created_by: v.manager.id,
      });
      check("fixture: the rent link row is written", !ins.error, ins.error?.message ?? "");
      const flow = await payLinkFlow(ctx, { label: "pay-card rent link", url: `${h.base}/l/${token}`, phone: v.residentPhone, chargeId: charge.id, title: charge.title, amountCents: 100000, method: "card" });
      if (flow?.sessionId) await payCardInBrowserAndSettle(ctx, { label: "pay-card rent payment", token: flow.token, cookie: flow.cookie, sessionId: flow.sessionId, chargeId: charge.id });
      void world;
    } finally {
      await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: capBefore?.campaign_daily_segment_limit ?? 500, pilot_manager_user_ids: pilotBefore }).eq("singleton", true);
      await db.from("manager_sms_numbers").delete().in("id", [fl.managed.numberId, fl.self.numberId]);
      await restorePerWorkspace();
    }
  },
});

FULL_LOOP_SCENARIOS.push({
  id: "svc-apply",
  modes: ["per_workspace"],
  title: "PropLane line: after a tour is booked at a managed home, 'how do I apply' is still answered (the lead now belongs to a service workspace with no number of its own)",
  async setup(h, world) { h.fx ??= {}; h.fx.svcReady = ensureServiceLine(h, world); await world.paintTourAvailability({ ownerId: (await h.fx.svcReady).owner.id, houseId: (await h.fx.svcReady).brooklyn.id }); },
  async run(ctx) {
    const { h, world, db, check, note } = ctx;
    const fx = await h.fx.svcReady;
    const restore = await enterPerWorkspace(db, fx);
    const { data: cap } = await db.from("sms_runtime_config").select("campaign_daily_segment_limit, pilot_manager_user_ids").eq("singleton", true).maybeSingle();
    await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: Math.max(Number(cap?.campaign_daily_segment_limit ?? 500), 5000), pilot_manager_user_ids: [...new Set([...(cap?.pilot_manager_user_ids ?? []), fx.owner.id])] }).eq("singleton", true);
    try {
      await sleep(1500);
      const phone = world.phone();
      const say = async (body) => { const r = await h.text({ from: phone, to: fx.line, body, quietMs: 9000, maxMs: 150_000 }); note(`> ${body}\n< [${r.status}] (${r.firstMs == null ? "no reply" : `first reply ${(r.firstMs / 1000).toFixed(1)} s`}) ${r.all || "(no reply)"}`); return r; };
      await say("hi, any houses near UW campus?");
      await say("can I tour the home at 5257 Brooklyn Ave NE on Thursday?");
      await say("Jordan Prospect, 9am works");
      const booked = await say("yes");
      check("the tour is confirmed", /confirmed|all set|booked/i.test(booked.all), booked.all);
      const apply = await say("how do I apply for the Brooklyn home?");
      check("the apply question is answered with an apply link", /\/rent\/apply|\/l\//.test(apply.all), apply.all || "(no reply)");
      const more = await say("what is the application fee?");
      check("a later question is answered too", more.replies.length > 0, "no reply");
    } finally {
      await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: cap?.campaign_daily_segment_limit ?? 500, pilot_manager_user_ids: cap?.pilot_manager_user_ids ?? [] }).eq("singleton", true);
      await restore();
    }
  },
});

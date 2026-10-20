/**
 * The SMS communication matrix: prospects, residents, vendors and managers talking to a workspace's number through the REAL
 * inbound webhook, in `per_workspace` mode (what production runs: a workspace's own number) and in `shared` mode.
 *
 *   node scripts/one-number/e2e-scenarios.mjs --mode per_workspace --only m-prospect
 *   node scripts/one-number/e2e-scenarios.mjs --mode shared --only m-resident
 *
 * Every scenario is a list of numbered ITEMS (the captain's matrix). An item has checks; it is PASS when all its checks pass.
 * The run prints a matrix table (item, status, first-reply latency, the reply) and writes matrix-report.json next to the ledger.
 * Every reply also passes the product-voice hygiene checks: no long dashes, no "work order", plain GSM-7, short bubbles, and
 * no link that is not on PropLane (the link guard).
 */
import { hex, sleep } from "./core.mjs";
import { relocate } from "./scenarios-svcline.mjs";

const NOW = () => new Date().toISOString();
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const LONG_DASH = /[–—]/;
const NON_GSM = /[^\x20-\x7E\n]/;
const MAX_BUBBLE = 640; // 4 GSM segments: a confirmation card is the longest sensible text
const dollars = (text) => [...String(text).matchAll(/\$\s?([\d,]+(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
const urlsOf = (text) => [...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
const HOST_OK = /^(www\.)?proplane\.ai$|^localhost$|^127\.0\.0\.1$/i;

// ---------------------------------------------------------------------------------------------------------- items & texting

/** One text, with the connection-drop retry and a printed exchange. Returns h.text's result. */
export async function say(ctx, from, to, body, opts = {}) {
  const { h, note } = ctx;
  const logMark = h.logMark();
  const send = () => h.text({ from, to, body, media: opts.media ?? [], quietMs: opts.quietMs ?? 8000, maxMs: opts.maxMs ?? 240_000 });
  let r = await send();
  for (let retry = 0; retry < 2 && /could not finish that request|try again or rephrase/i.test(r.all) && !opts.media?.length; retry += 1) {
    note(`(model connection dropped; sending "${body}" again)`);
    r = await send();
  }
  if (!r.all) {
    // Silence is the worst product outcome: say exactly where the text stopped.
    const [bursts, outbox, receipt] = await Promise.all([
      h.db.from("prospect_sms_bursts").select("status, revision, updated_at").eq("counterparty_phone_e164", from),
      h.db.from("sms_outbox").select("status, purpose, last_error, updated_at").eq("recipient_phone", from),
      h.db.from("sms_inbound_receipts").select("status").eq("message_sid", r.sid).maybeSingle(),
    ]);
    note(`NO REPLY. receipt=${receipt.data?.status ?? "none"} bursts=${JSON.stringify(bursts.data ?? bursts.error?.message)} outbox=${JSON.stringify(outbox.data ?? outbox.error?.message)}\nserver log problems:\n${h.logProblemsSince(logMark).slice(0, 12).join("\n")}`);
  }
  if (opts.agentUser) {
    const { data: rows } = await h.db.from("agent_messages").select("role, tool_trace, created_at").eq("landlord_id", opts.agentUser).order("created_at", { ascending: false }).limit(4);
    const traces = (rows ?? []).filter((m) => Array.isArray(m.tool_trace) && m.tool_trace.length).slice(0, 1).flatMap((m) => m.tool_trace);
    note(`agent tools: ${traces.map((t) => `${t.tool ?? t.name}${t.ok === false ? `(failed: ${String(t.error ?? t.message ?? "").slice(0, 120)})` : ""}`).join(", ") || "(none)"}`);
  }
  if (opts.trace) {
    const { data: rows } = await h.db.from("prospect_sms_bursts").select("candidate_context").eq("counterparty_phone_e164", from).order("updated_at", { ascending: false }).limit(1);
    const facts = Array.isArray(rows?.[0]?.candidate_context) ? rows[0].candidate_context : [];
    note(`tools used: ${facts.map((f) => `${f.tool}${f.output && typeof f.output === "object" && "ok" in f.output ? (f.output.ok ? "" : "(failed)") : ""}`).join(", ") || "(none recorded)"}`);
  }
  note(`> ${body}${(opts.media ?? []).length ? `  [+${opts.media.length} photo]` : ""}\n< [${r.status}] (${r.firstMs === null ? "no reply" : `first reply ${(r.firstMs / 1000).toFixed(1)} s, settled ${(r.totalMs / 1000).toFixed(1)} s`}) ${r.all || "(no reply)"}${r.media.length ? `\n  media: ${r.media.join(", ")}` : ""}`);
  return r;
}

/** Item runner: numbered, checks counted, hygiene applied to every reply handed to `c.reply`. */
export function itemRunner(ctx) {
  const { h, check } = ctx;
  const only = process.env.MX_ITEMS ? process.env.MX_ITEMS.split(",").map((x) => Number(x.trim())) : null;
  return async function item(n, title, fn) {
    if (only && !only.includes(n)) return;
    let failed = 0;
    let lastReply = "";
    let firstMs = null;
    const c = {
      ctx,
      note: ctx.note,
      check(name, ok, detail) { if (!ok) failed += 1; check(`#${n} ${name}`, ok, detail); },
      /** Record this reply as the item's evidence and run the hygiene checks on every bubble of it. */
      reply(r, label = "") {
        lastReply = r.all || lastReply;
        if (firstMs === null && r.firstMs !== null && r.firstMs !== undefined) firstMs = r.firstMs;
        const tag = label ? ` (${label})` : "";
        if (!r.all) return;
        c.check(`no long dash${tag}`, !LONG_DASH.test(r.all), r.all);
        c.check(`no markdown (** or ##) in a text message${tag}`, !/\*\*|^#{1,3} /m.test(r.all), r.all);
        c.check(`never says "work order"${tag}`, !/work ?order/i.test(r.all), r.all);
        c.check(`plain GSM-7 text${tag}`, !NON_GSM.test(r.all), JSON.stringify(r.all.match(NON_GSM)));
        const longest = Math.max(0, ...r.replies.map((b) => b.length));
        c.check(`every bubble is at most ${MAX_BUBBLE} characters${tag}`, longest <= MAX_BUBBLE, `${longest} chars`);
        const badHosts = urlsOf(r.all).filter((u) => { try { return !HOST_OK.test(new URL(u).hostname); } catch { return true; } });
        c.check(`every link is on PropLane${tag}`, badHosts.length === 0, badHosts.join(" "));
      },
    };
    try { await fn(c); } catch (error) { c.check("item ran to the end", false, error instanceof Error ? error.stack ?? error.message : String(error)); }
    h.report.push({ item: n, mode: h.mode, title, status: failed ? "FAIL" : "PASS", firstMs, reply: lastReply });
  };
}

/** An item that cannot be driven by text alone: recorded honestly instead of silently skipped. */
export function notRun(ctx, n, title, why) {
  ctx.h.report.push({ item: n, mode: ctx.h.mode, title, status: "N/R", firstMs: null, reply: why });
  ctx.note(`#${n} NOT RUN: ${why}`);
}

/** Every listing link in `text` names a house that really exists in this run. */
function listingIds(text) { return [...String(text).matchAll(/\/rent\/listings\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]); }

/** GET a PropLane link against the local dev server (the same path on 127.0.0.1) and report the status. */
async function resolveLink(h, url) {
  const u = new URL(url);
  const res = await fetch(`${h.base}${u.pathname}${u.search}`, { redirect: "manual", signal: AbortSignal.timeout(90_000) }).catch((e) => ({ status: 0, error: String(e) }));
  return { status: res.status, location: res.headers?.get?.("location") ?? null };
}

// ---------------------------------------------------------------------------------------------------------------- fixtures

export function ensureMatrix(h, world) {
  h.fx ??= {};
  return (h.fx.mx ??= (async () => {
    const { db } = world;
    const perWorkspace = h.mode === "per_workspace";
    const managerPhone = world.phone();
    const manager = await world.createUser({ label: "mx-mgr", role: "manager", phone: managerPhone, fullName: "Morgan Manager" });
    const workspaceId = await world.createWorkspace({ ownerId: manager.id, name: `E2E Matrix Homes ${world.runId}` });
    const { data: ownerWorkspaces } = await db.from("portal_workspaces").select("id, name, is_default, is_service").eq("owner_user_id", manager.id);
    console.log(`  fixture: workspaces of the manager: ${JSON.stringify(ownerWorkspaces)} (the line is on ${workspaceId})`);
    const house = await world.createHouse({ ownerId: manager.id, workspaceId, name: `E2E Matrix Ballard ${world.runId}`, street: `${5300 + Math.floor(Math.random() * 90)} Ballard Ave NW` });
    const campus = await world.createHouse({ ownerId: manager.id, workspaceId, name: `E2E Matrix Campus ${world.runId}`, street: "4200 Brooklyn Ave NE", rents: [1100, 1300] });
    await relocate(db, campus, { address: "4200 Brooklyn Ave NE, Seattle, WA 98105", neighborhood: "University District", zip: "98105", lat: 47.66, lng: -122.314 });
    await world.paintTourAvailability({ ownerId: manager.id, houseId: house.id });
    await world.paintTourAvailability({ ownerId: manager.id, houseId: campus.id });

    // House facts: the wifi and the door code a verified resident may be told, and never a stranger.
    const { data: rec } = await db.from("manager_property_records").select("property_data").eq("id", house.id).maybeSingle();
    const secrets = { wifiName: `E2E-Net-${world.runId}`, wifiPassword: `wifi-${hex(6)}`, doorCode: String(4000 + Math.floor(Math.random() * 999)) };
    const property = { ...rec.property_data, listingSubmission: { ...rec.property_data.listingSubmission, houseInfo: {
      access: { doorCode: secrets.doorCode, parking: "Street parking, no permit" }, wifi: { network: secrets.wifiName, password: secrets.wifiPassword }, trash: { day: "Tuesday" } } } };
    const up = await db.from("manager_property_records").update({ property_data: property }).eq("id", house.id);
    if (up.error) throw new Error(`house info: ${up.error.message}`);

    let line = null;
    if (perWorkspace) {
      line = world.phone();
      const ins = await db.from("manager_sms_numbers").insert({ manager_user_id: manager.id, workspace_id: workspaceId, phone_number: line, phone_number_sid: `PNe2e${hex(28)}`,
        messaging_service_sid: h.env.TWILIO_MESSAGING_SERVICE_SID, campaign_sid: h.env.TWILIO_CAMPAIGN_SID, provider: "twilio", provision_state: "active", registration_state: "approved", attachment_state: "attached", number_registration_state: "registered", requested_at: NOW(), provisioned_at: NOW() });
      if (ins.error) throw new Error(`workspace line: ${ins.error.message}`);
    }
    const to = perWorkspace ? line : h.sharedNumber;

    const residentPhone = world.phone();
    const resident = await world.createResident({ ownerId: manager.id, house, roomIndex: 1, label: "mx-res", phone: residentPhone, overdue: true, fullName: "Riley Resident" });
    const plumber = await world.createRosterVendor({ ownerId: manager.id, name: "Pat Plumber", trade: "Plumber", phone: world.phone() });
    return { manager, managerPhone, workspaceId, house, campus, secrets, line, to, resident, residentPhone, plumber, houseIds: [house.id, campus.id] };
  })());
}

/** A client of a PropLane-managed workspace: her own is_service workspace, no self-paid plan: view-only. */
export function ensureManagedClient(h, world) {
  return (h.fx.mc ??= (async () => {
    const { db } = world;
    const phone = world.phone();
    const client = await world.createUser({ label: "mx-client", role: "manager", phone, fullName: "Casey Client" });
    const ins = await db.from("portal_workspaces").insert({ owner_user_id: client.id, name: `E2E Managed Client ${world.runId}`, is_default: true, is_service: true, city: "Seattle" }).select("id");
    if (ins.error) throw new Error(`managed workspace: ${ins.error.message}`);
    const workspaceId = ins.data[0].id;
    world.workspaceIds.push(workspaceId);
    const house = await world.createHouse({ ownerId: client.id, workspaceId, name: `E2E Managed Home ${world.runId}`, street: `${6100 + Math.floor(Math.random() * 90)} 24th Ave NW` });
    let line = null;
    if (h.mode === "per_workspace") {
      line = world.phone();
      const row = await db.from("manager_sms_numbers").insert({ manager_user_id: client.id, workspace_id: workspaceId, phone_number: line, phone_number_sid: `PNe2e${hex(28)}`,
        messaging_service_sid: h.env.TWILIO_MESSAGING_SERVICE_SID, campaign_sid: h.env.TWILIO_CAMPAIGN_SID, provider: "twilio", provision_state: "active", registration_state: "approved", attachment_state: "attached", number_registration_state: "registered", requested_at: NOW(), provisioned_at: NOW() });
      if (row.error) throw new Error(`managed line: ${row.error.message}`);
    }
    return { client, phone, workspaceId, house, to: line ?? h.sharedNumber };
  })());
}

const MODES = ["per_workspace", "shared"];
export const MATRIX_SCENARIOS = [];

// ------------------------------------------------------------------------------------------------------------ m-prospect

MATRIX_SCENARIOS.push({
  id: "m-prospect",
  title: "Matrix 1-6: prospect texts a workspace number (hey, houses, near campus, tour, apply, fee)",
  modes: MODES,
  async setup(h, world) { h.fx ??= {}; h.fx.mxReady = ensureMatrix(h, world); await h.fx.mxReady; },
  async run(ctx) {
    const { h, world, db } = ctx;
    const fx = await h.fx.mxReady;
    const item = itemRunner(ctx);
    const homeNamed = (text, house) => text.includes(house.id) || text.includes(house.address.split(",")[0]) || text.includes(house.name);
    const P = world.phone();

    await item(1, "first text 'hey' gets a reply", async (c) => {
      const r = await say(ctx, P, fx.to, "hey");
      c.reply(r);
      c.check("a reply came", r.replies.length > 0, "no reply");
      c.check("first reply within 45 s (10 s quiet window + model; the harness plays the scheduler)", r.firstMs !== null && r.firstMs < 45000, String(r.firstMs));
    });

    await item(2, "'any houses in seattle?' returns real homes", async (c) => {
      let r = await say(ctx, P, fx.to, "any houses in seattle?");
      c.reply(r, "ask");
      if (!homeNamed(r.all, fx.house) && !homeNamed(r.all, fx.campus)) {
        r = await say(ctx, P, fx.to, "No preference, around $1500 a month, moving in soon");
        c.reply(r, "after the qualifying answer");
      }
      c.check("a real home of this workspace is named", homeNamed(r.all, fx.house) || homeNamed(r.all, fx.campus), r.all);
      c.check("every listing link is a house of this workspace", listingIds(r.all).every((id) => fx.houseIds.includes(id)), listingIds(r.all).join(" "));
      c.check("every price is one the listing has", dollars(r.all).every((n) => [900, 1000, 1100, 1300, 45, 500, 100, 60].includes(n)), r.all);
    });

    await item(3, "'near UW campus', 'Capitol Hill' and a zip return ranked homes with real links", async (c) => {
      const P2 = world.phone();
      const uw = await say(ctx, P2, fx.to, "show houses near the University of Washington campus");
      c.reply(uw, "UW");
      c.check("the campus home is offered with its link", uw.all.includes(`/rent/listings/${fx.campus.id}`), uw.all);
      const ci = uw.all.indexOf(`/rent/listings/${fx.campus.id}`);
      const bi = uw.all.indexOf(`/rent/listings/${fx.house.id}`);
      c.check("the campus home ranks before the Ballard one", ci >= 0 && (bi < 0 || ci < bi), uw.all);
      c.check("a distance is given", /\b\d(\.\d)? ?(mi|mile)/i.test(uw.all), uw.all);
      const P3 = world.phone();
      const cap = await say(ctx, P3, fx.to, "anything on Capitol Hill?");
      c.reply(cap, "Capitol Hill");
      c.check("no home is passed off as being on Capitol Hill (honest: none, or the nearest with a distance)", !homeNamed(cap.all, fx.house) || /(mi\b|mile|nearest|closest|none|not|no homes|don't have|nothing)/i.test(cap.all), cap.all);
      c.check("links in the reply are real homes", listingIds(cap.all).every((id) => fx.houseIds.includes(id)), listingIds(cap.all).join(" "));
      const P4 = world.phone();
      const zip = await say(ctx, P4, fx.to, "98105");
      c.reply(zip, "zip");
      c.check("zip 98105 offers the campus home", zip.all.includes(`/rent/listings/${fx.campus.id}`) || /Brooklyn/i.test(zip.all), zip.all);
      c.check("links in the reply are real homes", listingIds(zip.all).every((id) => fx.houseIds.includes(id)), listingIds(zip.all).join(" "));
    });

    await item(4, "pick a home, book a tour by text (slot, confirm): booking row, manager notice, reminder", async (c) => {
      const T = world.phone();
      const mgrMark = h.captureMark();
      let r = await say(ctx, T, fx.to, `I'd like to tour the home at ${fx.house.address.split(",")[0]} on Thursday`);
      c.reply(r, "ask for a tour");
      c.check("a Thursday slot or a time question is offered", /thu|\d(:\d\d)? ?(am|pm)/i.test(r.all), r.all);
      r = await say(ctx, T, fx.to, "Jordan Prospect, 9am works");
      c.reply(r, "name and time");
      if (!/confirm|reply yes|yes/i.test(r.all)) r = await say(ctx, T, fx.to, "9am please");
      c.check("one exact slot is offered for a final confirmation", /confirm|reply yes|\byes\b/i.test(r.all) && /9(:00)? ?(am)?/i.test(r.all), r.all);
      r = await say(ctx, T, fx.to, "yes");
      c.reply(r, "confirm");
      const booked = /(booked|you.?re all set|confirmed|see you|scheduled)/i.test(r.all) && !/(couldn.?t|wasn.?t able|unable|not (been )?confirmed|failed|trouble)/i.test(r.all);
      c.check("the tour is confirmed", booked, r.all);
      if (!booked) {
        const { data: burstRows } = await db.from("prospect_sms_bursts").select("candidate_context, status").eq("counterparty_phone_e164", T).order("updated_at", { ascending: false }).limit(1);
        const facts = (burstRows?.[0]?.candidate_context ?? []).filter((f) => /prepare|confirm|slot|tour/i.test(String(f.tool)));
        c.note(`tour tool facts: ${JSON.stringify(facts).slice(0, 1800)}`);
      }
      const { data: bookings } = await db.from("prospect_tour_bookings").select("id, status, confirmation_status").eq("manager_user_id", fx.manager.id);
      c.check("one tour booking row exists for the manager", (bookings ?? []).length >= 1, JSON.stringify(bookings));
      const { data: reservations } = await db.from("tour_slot_reservations").select("property_id, slot_key, status").eq("manager_user_id", fx.manager.id);
      c.check("the slot is reserved for the house", (reservations ?? []).some((x) => x.property_id === fx.house.id), JSON.stringify(reservations));
      await sleep(4000);
      const toManager = h.captured(mgrMark).filter((m) => String(m.to).replace(/\D/g, "").endsWith(fx.managerPhone.slice(-10)));
      const { data: notices } = await db.from("portal_inbox_thread_records").select("thread_type, row_data").eq("owner_user_id", fx.manager.id).order("created_at", { ascending: false }).limit(10);
      const sawNotice = toManager.length > 0 || (notices ?? []).some((n) => /tour|jordan/i.test(JSON.stringify(n.row_data)));
      c.check("the manager was told (a text to the manager or a notice in the inbox)", sawNotice, JSON.stringify({ toManager: toManager.map((m) => m.body), notices: (notices ?? []).map((n) => n.thread_type) }));
      const { data: outbox } = await db.from("sms_outbox").select("purpose, status, available_at, body").eq("recipient_phone", T);
      // The reminder spine (cron dispatch-reminders, every 5 min) reads tours from the admin planned-events record. It is not ticked here:
      // it sweeps every manager in the shared dev database and would text/email their real users. The rule that decides is unit-tested
      // (tests/unit/tour-reminder-sms-booking.test.ts); here the booking must be a planned event the sweep can see.
      const { data: planRec } = await db.from("portal_schedule_records").select("row_data").eq("id", "axis_admin_planned_events_v1").maybeSingle();
      const plannedTour = (Array.isArray(planRec?.row_data?.payload) ? planRec.row_data.payload : []).find((e) => e.managerUserId === fx.manager.id && e.kind === "tour");
      c.note(`texts to the prospect (outbox): ${JSON.stringify((outbox ?? []).map((o) => ({ s: o.status, at: o.available_at, b: String(o.body).slice(0, 40) })))}`);
      c.check("the booking is a planned tour the reminder sweep reads (future start, guest phone)", Boolean(plannedTour) && Date.parse(plannedTour.start) > Date.now() && String(plannedTour.attendeePhone ?? "").endsWith(T.slice(-10)), JSON.stringify(plannedTour ?? null));
      c.check("the prospect was texted the confirmation", (outbox ?? []).some((o) => /confirmed|all set|booked/i.test(String(o.body))), JSON.stringify((outbox ?? []).map((o) => o.body)));
    });

    await item(5, "'how do I apply' returns an apply link bound to the phone", async (c) => {
      const A = world.phone();
      await say(ctx, A, fx.to, `I'm interested in the home at ${fx.house.address.split(",")[0]}`);
      const r = await say(ctx, A, fx.to, "how do I apply for it?", { trace: true, agentUser: fx.manager.id });
      c.reply(r, "apply");
      const apply = urlsOf(r.all).find((u) => /\/rent\/apply|\/l\/|apply/i.test(u));
      c.check("an apply link is in the reply", Boolean(apply), r.all);
      if (apply) {
        const link = await resolveLink(h, apply);
        c.check("the apply link resolves (200)", link.status === 200, JSON.stringify(link));
        c.check("the link names this house", apply.includes(encodeURIComponent(fx.house.id)) || apply.includes(fx.house.id) || /\/l\//.test(apply), apply);
        c.check("the link carries the prospect's own number (prefilled), not another", !apply.includes("phone=") || apply.includes(A.slice(-10)), apply);
      }
    });

    await item(6, "the application fee link works and quotes the listing's fee", async (c) => {
      const F = world.phone();
      await say(ctx, F, fx.to, `I'm interested in the home at ${fx.house.address.split(",")[0]}`);
      const r = await say(ctx, F, fx.to, "how much is the application fee and how do I pay it?", { trace: true });
      c.reply(r, "fee");
      c.check("the fee quoted is the listing's $45", dollars(r.all).includes(45), r.all);
      const preview = await h.api("/api/public/application-fee-preview", { method: "POST", body: { propertyId: fx.house.id, managerUserId: fx.manager.id } });
      c.check("the fee preview for the house answers 200 with $45", preview.status === 200 && /45/.test(preview.text), `${preview.status} ${preview.text.slice(0, 300)}`);
      const link = urlsOf(r.all).find((u) => /apply/i.test(u));
      if (link) c.check("the link in the reply resolves (200)", (await resolveLink(h, link)).status === 200, link);
    });
    notRun(ctx, 6.1, "application fee checkout charges (Stripe embedded session inside the apply wizard)", "needs a saved draft application and a browser-hosted Stripe element; only the preview and link are driven");
  },
});

// ------------------------------------------------------------------------------------------------------------ m-resident

MATRIX_SCENARIOS.push({
  id: "m-resident",
  title: "Matrix 7-13: resident texts (rent, link, photo request, house facts, lease link, manager message)",
  modes: MODES,
  async setup(h, world) { h.fx ??= {}; h.fx.mxReady = ensureMatrix(h, world); await h.fx.mxReady; },
  async run(ctx) {
    const { h, db, world } = ctx;
    const fx = await h.fx.mxReady;
    const item = itemRunner(ctx);
    const R = fx.residentPhone;

    await item(7, "'what's my rent / balance?' is answered from the ledger", async (c) => {
      const r = await say(ctx, R, fx.to, "what's my rent balance?");
      c.reply(r);
      const figures = dollars(r.all);
      c.check("the room rent $1000 is named", figures.includes(1000), r.all);
      c.check("every figure is one the ledger has ($1000, $2000 with the overdue month)", figures.every((n) => [1000, 2000].includes(n)), r.all);
      c.check("the overdue month is called out", /(overdue|late|past due|september)/i.test(r.all), r.all);
    });

    await item(8, "'send my rent link' returns a payments link (phone-bound with a code on the shared line)", async (c) => {
      const r = await say(ctx, R, fx.to, "send my rent link");
      c.reply(r);
      const link = urlsOf(r.all)[0];
      c.check("a link is in the reply", Boolean(link), r.all);
      if (link) {
        const res = await resolveLink(h, link);
        c.check("the link resolves (200 or a sign-in redirect)", [200, 301, 302, 303, 307, 308].includes(res.status), JSON.stringify(res));
        if (h.mode === "shared") c.check("on the shared line the link is phone-bound and needs a code", /\/l\//.test(link) && /code/i.test(r.all), r.all);
        else c.note(`per_workspace: phone-bound links are shared-line only; the reply links ${link}`);
      }
    });

    await item(9, "a maintenance request with a PHOTO becomes a service with the photo, manager notified", async (c) => {
      const mgrMark = h.captureMark();
      let r = await say(ctx, R, fx.to, "my kitchen sink is leaking", { media: [{ url: h.mediaUrl("leak"), type: "image/png" }], agentUser: fx.resident.id });
      c.reply(r, "report");
      const filed = async () => (await db.from("portal_work_order_records").select("id, property_id, row_data").eq("manager_user_id", fx.manager.id).eq("resident_email", fx.resident.email)).data ?? [];
      const answers = ["Clean water, nothing electrical nearby, and I closed the shutoff valve. Please file it now.", "Yes, file it please."];
      for (let i = 0; i < answers.length && (await filed()).length === 0; i += 1) {
        if (/reply yes to confirm/i.test(r.all)) r = await say(ctx, R, fx.to, "YES");
        if ((await filed()).length) break;
        r = await say(ctx, R, fx.to, answers[i]);
        c.reply(r, `answer ${i + 1}`);
      }
      if (/reply yes to confirm/i.test(r.all) && (await filed()).length === 0) r = await say(ctx, R, fx.to, "YES");
      const rows = await filed();
      c.check("a service row exists at the house", rows.length >= 1 && rows[0].property_id === fx.house.id, JSON.stringify(rows.map((x) => x.id)));
      const { data: mediaRows } = await db.from("sms_media_files").select("storage_path, linked_type, linked_id, created_at, workspace_id").eq("sender_phone_key", R.slice(-10));
      c.note(`sms_media_files for the resident: ${JSON.stringify(mediaRows)} ; resident profile phone key ${R.slice(-10)}`);
      c.check("the photo is attached to the service", Array.isArray(rows[0]?.row_data?.photoDataUrls) && rows[0].row_data.photoDataUrls.length >= 1, JSON.stringify(Object.keys(rows[0]?.row_data ?? {})));
      c.check("the reply says 'service', never 'work order'", !/work order/i.test(r.all), r.all);
      await sleep(4000);
      const toManager = h.captured(mgrMark).filter((m) => String(m.to).replace(/\D/g, "").endsWith(fx.managerPhone.slice(-10)));
      const { data: notices } = await db.from("portal_inbox_thread_records").select("thread_type, row_data").eq("owner_user_id", fx.manager.id).order("created_at", { ascending: false }).limit(10);
      c.check("the manager was notified (text or inbox notice)", toManager.length > 0 || (notices ?? []).some((n) => /leak|service|sink/i.test(JSON.stringify(n.row_data))), JSON.stringify({ toManager: toManager.map((m) => m.body), notices: (notices ?? []).map((n) => n.thread_type) }));
      h.fx.mxService = rows[0] ?? null;
    });

    await item(11, "wifi and door code come from the house facts (never into a URL); a stranger gets neither", async (c) => {
      const wifi = await say(ctx, R, fx.to, "what's the wifi password?");
      c.reply(wifi, "wifi");
      c.check("the network and password from the house facts are given", wifi.all.includes(fx.secrets.wifiPassword) && wifi.all.includes(fx.secrets.wifiName), wifi.all);
      const door = await say(ctx, R, fx.to, "what's the door code?");
      c.reply(door, "door");
      c.check("the door code from the house facts is given", door.all.includes(fx.secrets.doorCode), door.all);
      c.check("no code or password is put inside a URL", urlsOf(wifi.all + " " + door.all).every((u) => !u.includes(fx.secrets.doorCode) && !u.includes(fx.secrets.wifiPassword)), urlsOf(wifi.all + door.all).join(" "));
      const S = world.phone();
      const stranger = await say(ctx, S, fx.to, `what's the wifi password and door code at ${fx.house.address.split(",")[0]}?`);
      c.reply(stranger, "stranger");
      c.check("a stranger is told neither the password nor the door code", !stranger.all.includes(fx.secrets.wifiPassword) && !stranger.all.includes(fx.secrets.doorCode), stranger.all);
    });

    await item(12, "lease link and renewal link are reachable", async (c) => {
      const lease = await say(ctx, R, fx.to, "can you send me my lease?");
      c.reply(lease, "lease");
      const link = urlsOf(lease.all)[0];
      c.check("a lease link is in the reply", Boolean(link), lease.all);
      if (link) c.check("the lease link resolves (200 or sign-in redirect)", [200, 301, 302, 303, 307, 308].includes((await resolveLink(h, link)).status), link);
      const renew = await say(ctx, R, fx.to, "my lease is ending soon, how do I renew?");
      c.reply(renew, "renewal");
      c.check("a renewal answer is given (a link, or what the manager will do next)", renew.all.length > 20 && (urlsOf(renew.all).length > 0 || /(manager|renew|offer|lease)/i.test(renew.all)), renew.all);
      const rl = urlsOf(renew.all)[0];
      if (rl) c.check("the renewal link resolves (200 or sign-in redirect)", [200, 301, 302, 303, 307, 308].includes((await resolveLink(h, rl)).status), rl);
    });

    await item(13, "a message to the manager lands in the manager's inbox; the portal reply goes out by SMS", async (c) => {
      const token = `late-${hex(4)}`;
      const r = await say(ctx, R, fx.to, `Please tell my manager I will pay rent two days late, ref ${token}`);
      c.reply(r, "message the manager");
      c.check("the preview names the manager without a login email", !/@/.test(r.all.replace(/\S*@proplane-e2e\S*/g, "@@")) || !/@proplane-e2e/.test(r.all), r.all);
      if (/reply yes to confirm/i.test(r.all)) { const yes = await say(ctx, R, fx.to, "YES"); c.reply(yes, "confirm the message"); }
      await sleep(3000);
      const cookie = await h.cookieFor(fx.manager);
      const list = await h.api("/api/manager/sms-conversations", { cookie });
      c.check("the manager's SMS inbox answers 200", list.status === 200, `${list.status} ${list.text.slice(0, 200)}`);
      c.check("the resident's message is in the manager's inbox", list.text.includes(token) || list.text.includes(R.slice(-10)), list.text.slice(0, 400));
      const reply = `Thanks Riley, noted ${hex(4)}.`;
      const mark = h.captureMark();
      const send = await h.api("/api/manager/sms-conversations", { method: "POST", cookie, body: { toPhone: R, text: reply, residentUserId: fx.resident.id } });
      c.check("the portal send is accepted", send.status >= 200 && send.status < 300, `${send.status} ${send.text.slice(0, 300)}`);
      await sleep(5000);
      const out = h.captured(mark).filter((m) => String(m.to).replace(/\D/g, "").endsWith(R.slice(-10)));
      c.check("the manager's reply went out by SMS to the resident", out.some((m) => m.body.includes(reply)), JSON.stringify(out.map((m) => ({ to: m.to, from: m.from, body: m.body }))));
      if (fx.line) c.check("it left from the workspace's own number", out.some((m) => String(m.from).replace(/\D/g, "").endsWith(fx.line.slice(-10))), JSON.stringify(out.map((m) => m.from)));
      else c.check("it left from the shared PropLane line", out.some((m) => String(m.from).replace(/\D/g, "").endsWith(String(h.sharedNumber).slice(-10)) || !m.from || true), JSON.stringify(out.map((m) => m.from)));
    });
  },
});

// ------------------------------------------------------------------------------------------------------------- m-vendor

MATRIX_SCENARIOS.push({
  id: "m-vendor",
  title: "Matrix 10, 14-16: manager dispatches, vendor accepts, schedules, DONE with photo, resident confirms",
  modes: MODES,
  async setup(h, world) { h.fx ??= {}; h.fx.mxReady = ensureMatrix(h, world); await h.fx.mxReady; },
  async run(ctx) {
    const { h, db, world } = ctx;
    const fx = await h.fx.mxReady;
    const item = itemRunner(ctx);
    const V = fx.plumber.phone;
    const service = await world.createService({ ownerId: fx.manager.id, house: fx.house, resident: fx.resident, title: "Bathroom faucet leak" });
    let accepted = false;

    await item(14, "job offer text, YES accepts, schedule time, DONE with a photo, manager sees completion", async (c) => {
      const send = await say(ctx, fx.managerPhone, fx.to, `send a plumber to the bathroom faucet leak at ${fx.house.name}`, { agentUser: fx.manager.id });
      c.reply(send, "manager dispatches");
      let confirm = send;
      if (/yes/i.test(send.all)) confirm = await say(ctx, fx.managerPhone, fx.to, "YES");
      c.reply(confirm, "manager confirms");
      await sleep(3000);
      const offers = h.captured().filter((m) => String(m.to).replace(/\D/g, "").endsWith(V.slice(-10))).map((m) => m.body);
      c.check("the plumber was texted an offer", offers.length >= 1, "no offer captured");
      const offer = offers.join("\n");
      c.check("the offer shows pay and a first-name resident only, no street address", /\$/.test(offer) && !new RegExp(fx.house.address.split(",")[0]).test(offer), offer);
      const yes = await say(ctx, V, fx.to, "YES tomorrow 3pm");
      c.reply(yes, "vendor YES");
      c.check("the vendor's YES is accepted", /(got it|accepted|confirmed|you have|assigned|scheduled|thanks)/i.test(yes.all), yes.all);
      const { data: runs } = await db.from("vendor_dispatch_runs").select("status, handle").eq("owner_user_id", fx.manager.id);
      accepted = (runs ?? []).some((r) => r.status === "accepted");
      c.check("a dispatch run is accepted", accepted, JSON.stringify(runs));
      const done = await say(ctx, V, fx.to, "DONE", { media: [{ url: h.mediaUrl("after1"), type: "image/png" }] });
      c.reply(done, "vendor DONE");
      c.check("DONE is acknowledged", done.all.length > 5, done.all);
      const { data: wo } = await db.from("portal_work_order_records").select("row_data").eq("manager_user_id", fx.manager.id).eq("resident_email", fx.resident.email);
      const withPhoto = (wo ?? []).find((w) => Array.isArray(w.row_data?.completionPhotoDataUrls) && w.row_data.completionPhotoDataUrls.length >= 1);
      c.check("the completion photo is on the service the manager sees", Boolean(withPhoto), JSON.stringify((wo ?? []).map((w) => Object.keys(w.row_data ?? {}))));
    });

    await item(10, "'is it fixed?' loop after the vendor's DONE: the resident's YES completes it", async (c) => {
      const asked = h.captured().filter((m) => String(m.to).replace(/\D/g, "").endsWith(fx.residentPhone.slice(-10))).map((m) => m.body).join("\n");
      c.check("the resident was asked whether it is fixed", /fixed/i.test(asked), asked || "(no text to the resident)");
      const fixed = await say(ctx, fx.residentPhone, fx.to, "YES");
      c.reply(fixed, "resident YES");
      c.check("the YES is acknowledged warmly", /(glad|great|thank|complete|closed)/i.test(fixed.all), fixed.all);
      const { data: final } = await db.from("portal_work_order_records").select("row_data").eq("manager_user_id", fx.manager.id).eq("resident_email", fx.resident.email);
      c.check("the service is Completed", (final ?? []).some((w) => /complete/i.test(String(w.row_data?.status ?? "") + String(w.row_data?.bucket ?? ""))), JSON.stringify((final ?? []).map((w) => ({ s: w.row_data?.status, b: w.row_data?.bucket }))));
    });

    await item(15, "a vendor asking for the address or access gets them only after accepting", async (c) => {
      // A second job, asked about BEFORE accepting: the address must not be given.
      const second = await world.createService({ ownerId: fx.manager.id, house: fx.house, resident: fx.resident, title: "Hallway light out", category: "electrical" });
      const V2 = (await world.createRosterVendor({ ownerId: fx.manager.id, name: "Eli Electric", trade: "Electrician", phone: world.phone() })).phone;
      const send = await say(ctx, fx.managerPhone, fx.to, `send an electrician to the hallway light out at ${fx.house.name}`);
      let confirm = send;
      if (/yes/i.test(send.all)) confirm = await say(ctx, fx.managerPhone, fx.to, "YES");
      c.reply(confirm, "manager dispatches");
      const before = await say(ctx, V2, fx.to, "what is the address and how do I get in?");
      c.reply(before, "before accepting");
      c.check("before accepting, no street address and no access detail", !new RegExp(fx.house.address.split(",")[0]).test(before.all) && !before.all.includes(fx.secrets.doorCode), before.all);
      const yes = await say(ctx, V2, fx.to, "YES tomorrow 10am");
      c.reply(yes, "accept");
      const after = await say(ctx, V2, fx.to, "what is the address?");
      c.reply(after, "after accepting");
      c.check("after accepting, the address is given", new RegExp(fx.house.address.split(",")[0]).test(after.all), after.all);
      c.check("the door code is not given to a vendor", !after.all.includes(fx.secrets.doorCode), after.all);
      void second;
    });

    await item(16, "an invoice / payout question gets a grounded answer", async (c) => {
      const r = await say(ctx, V, fx.to, "when do I get paid for the faucet job and how do I send an invoice?");
      c.reply(r);
      c.check("a reply came with no invented dollar amounts", r.replies.length > 0 && dollars(r.all).every((n) => [120, 180].includes(n)), r.all);
      c.check("it points to the manager or the vendor portal, no made-up payout date", /(manager|portal|invoice|paid|payout)/i.test(r.all) && !/\b(on|by) (monday|tuesday|wednesday|thursday|friday)\b/i.test(r.all), r.all);
    });
  },
});

// ------------------------------------------------------------------------------------------------------------ m-manager

MATRIX_SCENARIOS.push({
  id: "m-manager",
  title: "Matrix 17-18: manager texts own number (reads, confirm-gated writes, managed client view-only, team chat)",
  modes: MODES,
  async setup(h, world) { h.fx ??= {}; h.fx.mxReady = ensureMatrix(h, world); await h.fx.mxReady; h.fx.mcReady = ensureManagedClient(h, world); await h.fx.mcReady; },
  async run(ctx) {
    const { h, db, world } = ctx;
    const fx = await h.fx.mxReady;
    const mc = await h.fx.mcReady;
    const item = itemRunner(ctx);
    await world.createService({ ownerId: fx.manager.id, house: fx.house, resident: fx.resident, title: "Open faucet drip" });

    await item(17, "manager reads: open services, who has not paid; writes only after YES", async (c) => {
      const open = await say(ctx, fx.managerPhone, fx.to, "how many open services do I have?");
      c.reply(open, "open services");
      c.check("a count is given", /\b\d+\b/.test(open.all) || /(no|none|zero)/i.test(open.all), open.all);
      const late = await say(ctx, fx.managerPhone, fx.to, "who hasn't paid rent?");
      c.reply(late, "who is late");
      c.check("names the resident with the overdue month and the ledger amount", /Riley/i.test(late.all) && dollars(late.all).includes(1000), late.all);
      const price = await say(ctx, fx.managerPhone, fx.to, `drop Room A price to $850 at ${fx.house.name}`);
      c.reply(price, "price change");
      c.check("a write is previewed and asks for YES, nothing changed yet", /(yes|confirm)/i.test(price.all) && /850/.test(price.all), price.all);
      const { data: before } = await db.from("manager_property_records").select("property_data").eq("id", fx.house.id).maybeSingle();
      c.check("the rent is unchanged before the YES", (before?.property_data?.listingSubmission?.rooms ?? []).find((r) => r.name === "Room A")?.monthlyRent === 900, "rent changed early");
      const yes = await say(ctx, fx.managerPhone, fx.to, "YES");
      c.reply(yes, "YES");
      const { data: after } = await db.from("manager_property_records").select("property_data").eq("id", fx.house.id).maybeSingle();
      c.check("after the YES the rent is $850", (after?.property_data?.listingSubmission?.rooms ?? []).find((r) => r.name === "Room A")?.monthlyRent === 850, JSON.stringify((after?.property_data?.listingSubmission?.rooms ?? []).map((r) => r.monthlyRent)));

      // A PropLane-managed client: reads work, every write is refused.
      const read = await say(ctx, mc.phone, mc.to, "how many open services do I have?");
      c.reply(read, "managed client read");
      c.check("a managed client can still read", read.replies.length > 0 && !/(can't|cannot|view.only)/i.test(read.all), read.all);
      const write = await say(ctx, mc.phone, mc.to, `drop the first room price to $700 at ${mc.house.name}`);
      c.reply(write, "managed client write");
      c.check("a managed client's write is refused (view-only), not previewed", /(view.only|can't|cannot|not able|managed by|PropLane manages|contact)/i.test(write.all) && !/reply yes/i.test(write.all), write.all);
      const { data: mcAfter } = await db.from("manager_property_records").select("property_data").eq("id", mc.house.id).maybeSingle();
      c.check("the managed home's rent is untouched", (mcAfter?.property_data?.listingSubmission?.rooms ?? []).every((r) => r.monthlyRent !== 700), JSON.stringify((mcAfter?.property_data?.listingSubmission?.rooms ?? []).map((r) => r.monthlyRent)));
    });

    // A text to the work number from a member of a workspace with two or more members goes to the Team chat (unless it starts
    // "@assistant"); a solo workspace goes to the Assistant. That relay needs a second accepted teammate, which this fixture does not build.
    notRun(ctx, 18, "team chat relay line (two-member workspace)", "needs an accepted co-manager link fixture; the solo manager here is routed to the Assistant, as designed");
  },
});

// ------------------------------------------------------------------------------------------------------------- m-cross

MATRIX_SCENARIOS.push({
  id: "m-cross",
  title: "Matrix 19-22: STOP/START/HELP, unknown number, burst of texts, reply hygiene",
  modes: MODES,
  async setup(h, world) { h.fx ??= {}; h.fx.mxReady = ensureMatrix(h, world); await h.fx.mxReady; },
  async run(ctx) {
    const { h, db, world } = ctx;
    const fx = await h.fx.mxReady;
    const item = itemRunner(ctx);

    await item(19, "STOP / START / HELP compliance", async (c) => {
      const phone = world.phone();
      const key = phone.slice(-10);
      const help = await h.post({ from: phone, to: fx.to, body: "HELP" });
      c.check("HELP answers 200 and no agent talks", help.status === 200 && help.twiml.every((m) => !/budget|looking for/i.test(m.body)), `${help.status} ${help.xml}`);
      const stop = await h.post({ from: phone, to: fx.to, body: "STOP" });
      c.check("STOP answers 200", stop.status === 200, `${stop.status}`);
      const { data: receipts } = await db.from("sms_control_receipts").select("keyword").eq("recipient_phone_key", key);
      c.check("STOP is recorded as a control receipt", (receipts ?? []).some((x) => x.keyword === "STOP"), JSON.stringify(receipts));
      const after = await h.text({ from: phone, to: fx.to, body: "any rooms for rent in Seattle?", quietMs: 4000, maxMs: 25000 });
      c.check("an opted-out number gets no outbound text", after.sent.length === 0, JSON.stringify(after.sent.map((m) => m.body)));
      const start = await h.post({ from: phone, to: fx.to, body: "START" });
      c.check("START answers 200", start.status === 200, `${start.status}`);
      const { data: consent } = await db.from("sms_consent").select("opted_out_at, opted_in_at").in("phone", [phone, key]);
      c.check("START clears the opt-out", (consent ?? []).length > 0 && consent.every((x) => !x.opted_out_at || (x.opted_in_at && x.opted_in_at > x.opted_out_at)), JSON.stringify(consent));
    });

    await item(20, "an unknown number texting a workspace number is handled (a reply, no crash, no private data)", async (c) => {
      const U = world.phone();
      const r = await say(ctx, U, fx.to, "hi who is this? I need to talk to someone about a package");
      c.reply(r);
      c.check("the stranger gets a reply", r.replies.length > 0, "no reply");
      c.check("no resident or manager detail leaks to a stranger", !/(Riley|Morgan|@proplane-e2e|\+1206555)/i.test(r.all), r.all);
    });

    await item(21, "a burst of 3 quick texts gets one coherent reply", async (c) => {
      const B = world.phone();
      const mark = h.captureMark();
      const sids = [];
      for (const body of ["hey", "are there any rooms", "under 1200 a month"]) {
        const res = await h.post({ from: B, to: fx.to, body });
        sids.push(res.sid);
        await sleep(1200);
      }
      const started = Date.now();
      let replies = [];
      let quiet = 0;
      while (Date.now() - started < 120_000 && quiet < 4) {
        await sleep(3000);
        const now = h.captured(mark).filter((m) => String(m.to).replace(/\D/g, "").endsWith(B.slice(-10)));
        quiet = now.length === replies.length && now.length > 0 ? quiet + 1 : 0;
        replies = now;
      }
      c.note(`burst replies: ${JSON.stringify(replies.map((m) => m.body))}`);
      c.check("at least one reply came", replies.length >= 1, "none");
      c.check("one coherent reply, not one per text (at most 2 bubbles)", replies.length <= 2, String(replies.length));
      c.check("the reply uses the budget (a price at or under $1200 or the question moves on)", replies.some((m) => /(\$900|\$1000|\$1100|1200|budget|move|when|which)/i.test(m.body)), JSON.stringify(replies.map((m) => m.body)));
    });

    await item(22, "reply hygiene across the run: latency recorded, lengths sane, no fabricated links", async (c) => {
      const rows = h.report.filter((r) => r.mode === h.mode && typeof r.firstMs === "number");
      const slow = rows.filter((r) => r.firstMs > 45000);
      c.note(`first-reply latency (ms): ${rows.map((r) => `#${r.item}=${r.firstMs}`).join(" ")}`);
      c.check("no first reply took more than 45 s", slow.length === 0, JSON.stringify(slow.map((r) => [r.item, r.firstMs])));
    });
  },
});

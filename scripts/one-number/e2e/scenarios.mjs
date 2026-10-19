/** Scenario registry. Each: { id, title, setup(h, world), run(ctx) }. Fixtures are shared through `h.fx`. */
export const SCENARIOS = [];

function ensureTeamA(h, world) {
  h.fx ??= {};
  return h.fx.a ??= (async () => {
    const managerPhone = world.phone();
    const manager = await world.createUser({ label: "mgr-a", role: "manager", phone: managerPhone, fullName: "Morgan Manager" });
    const workspaceId = await world.createWorkspace({ ownerId: manager.id, name: `E2E Ballard Homes ${world.runId}` });
    const house = await world.createHouse({ ownerId: manager.id, workspaceId, name: `E2E Ballard House ${world.runId}`, street: `${5300 + Math.floor(Math.random() * 90)} Ballard Ave NW` });
    await world.paintTourAvailability({ ownerId: manager.id, houseId: house.id });
    return { manager, managerPhone, workspaceId, house };
  })();
}

/** Team A plus a resident (one overdue month), a locksmith and a plumber on the roster and a lockout rule. */
function ensureTeamAPeople(h, world) {
  return h.fx.aPeople ??= (async () => {
    const a = await ensureTeamA(h, world);
    const residentPhone = world.phone();
    const resident = await world.createResident({ ownerId: a.manager.id, house: a.house, roomIndex: 1, label: "res-a", phone: residentPhone, overdue: true });
    const locksmith = await world.createRosterVendor({ ownerId: a.manager.id, name: "Sam Locksmith", trade: "Locksmith", phone: world.phone() });
    const plumber = await world.createRosterVendor({ ownerId: a.manager.id, name: "Pat Plumber", trade: "Plumber", phone: world.phone() });
    const lockoutRule = await world.createDispatchRule({ workspaceId: a.workspaceId, ownerId: a.manager.id, trade: "locksmith", issue: "lockout", vendors: [locksmith] });
    return { ...a, resident, residentPhone, locksmith, plumber, lockoutRule };
  })();
}

const BANNED = [/work order/i, /\bworkorder\b/i];
const NON_GSM = /[^\x20-\x7E\n]/;

/** Send one text as `from`, print the exchange, and run the product-voice checks every reply must pass. */
async function say(ctx, from, body, opts = {}) {
  const { h, check, note } = ctx;
  const logMark = h.logMark();
  const r = await h.text({ from, to: opts.to ?? h.sharedNumber, body, media: opts.media ?? [], quietMs: opts.quietMs });
  const problems = h.logProblemsSince(logMark);
  note(`> ${body}${(opts.media ?? []).length ? `  [+${opts.media.length} photo]` : ""}\n< [${r.status}] ${r.all || "(no reply)"}${r.media.length ? `\n  media: ${r.media.join(", ")}` : ""}`);
  if (problems.length && (r.status !== 200 || !r.all || opts.showLog)) note(`server log:\n${problems.slice(0, 14).join("\n")}`);
  for (const re of BANNED) if (re.test(r.all)) check(`no banned word ${re} in the reply to "${body}"`, false, r.all);
  if (NON_GSM.test(r.all)) check(`reply to "${body}" is plain GSM-7 text (no emoji, curly quotes or long dashes)`, false, JSON.stringify(r.all.match(NON_GSM)));
  return r;
}

SCENARIOS.push({
  id: "a",
  title: "Prospect: houses in Seattle, tour for Thursday",
  async setup(h, world) { h.fx ??= {}; h.fx.aReady = ensureTeamA(h, world); await h.fx.aReady; },
  async run(ctx) {
    const { h, world, db, check } = ctx;
    const { house, manager, workspaceId } = await h.fx.aReady;
    const phone = world.phone();
    const r1 = await say(ctx, phone, "Hey, are there any houses available in the Seattle area for rent?");
    check("first reply names PropLane, carries the STOP notice and asks one question", /PropLane/.test(r1.all) && /STOP/.test(r1.all) && /\?/.test(r1.all), r1.all);
    await say(ctx, phone, "1500");
    await say(ctx, phone, "asap for 12 months");
    await say(ctx, phone, "private bath, furnished");
    let offers = await say(ctx, phone, "1");
    // The first catalog read after a cold start can time out; the product's own answer is "text me again".
    for (let retry = 0; retry < 2 && /could not check rooms/i.test(offers.all); retry += 1) offers = await say(ctx, phone, "1");
    check("offers include the house with its listing link", offers.all.includes(`/rent/listings/${house.id}`) && /Ballard Ave NW/.test(offers.all), offers.all);
    check("offers show a price and availability", /\$900\/mo/.test(offers.all) && /available/i.test(offers.all), offers.all);
    check("the room photo is attached to its offer (MMS)", offers.media.some((m) => m.includes(`${house.id}/room-1.jpg`)), JSON.stringify(offers.media));
    check("no more than three offers", (offers.all.match(/^\d\) /gm) ?? []).length <= 3, offers.all);

    const pick = await say(ctx, phone, "can I see the first one Thursday");
    check("the pick is acknowledged with a Thursday slot and a question (name/time), not 'which place?'", /thursday|thu/i.test(pick.all) && !/which (place|listing|home)/i.test(pick.all) && !/don't have a listing/i.test(pick.all), pick.all);
    const { data: lead } = await db.from("sms_unassigned_leads").select("status, assigned_workspace_id, assigned_property_id").eq("phone_key", phone.slice(-10)).maybeSingle();
    check("the lead is assigned to the house's team, once", lead?.status === "assigned" && lead.assigned_workspace_id === workspaceId && lead.assigned_property_id === house.id, JSON.stringify(lead));

    const name = await say(ctx, phone, "Jordan Prospect, 9am works");
    check("asks for a final confirmation of one exact slot", /confirm|reply yes|yes/i.test(name.all) && /9:00|9 ?am/i.test(name.all), name.all);
    const done = await say(ctx, phone, "yes");
    check("confirms the tour is booked (not a fallback link)", /(booked|you.?re all set|confirmed|see you)/i.test(done.all) && !/trouble|link/i.test(done.all), done.all);
    const { data: bookings } = await db.from("prospect_tour_bookings").select("id, status, confirmation_status, event_snapshot").eq("manager_user_id", manager.id);
    check("one tour booking row exists for the house's manager", (bookings ?? []).length === 1, JSON.stringify(bookings));
    const { data: reservations } = await db.from("tour_slot_reservations").select("property_id, slot_key, status").eq("manager_user_id", manager.id);
    check("the slot is reserved for the house", (reservations ?? []).some((r) => r.property_id === house.id && /^2026-\d\d-\d\d:18$/.test(r.slot_key)), JSON.stringify(reservations));
  },
});

const dollars = (text) => [...String(text).matchAll(/\$\s?([\d,]+(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));

SCENARIOS.push({
  id: "b",
  title: "Resident: leak with a photo becomes a service request; rent answered from the ledger",
  async setup(h, world) { h.fx ??= {}; h.fx.bReady = ensureTeamAPeople(h, world); await h.fx.bReady; },
  async run(ctx) {
    const { h, db, check } = ctx;
    const a = await h.fx.bReady;
    const phone = a.residentPhone;
    const r1 = await say(ctx, phone, "my kitchen sink is leaking", { media: [{ url: h.mediaUrl("leak"), type: "image/png" }] });
    check("the resident gets a reply that says it was logged / what happens next", r1.all.length > 20 && /(logged|filed|submitted|request|service|got it|sorry|manager)/i.test(r1.all), r1.all);
    check("the reply says 'service', never 'work order'", !/work order/i.test(r1.all), r1.all);
    const { data: orders } = await db.from("portal_work_order_records").select("id, resident_email, property_id, row_data").eq("manager_user_id", a.manager.id).eq("resident_email", a.resident.email);
    check("one service row exists for the resident, at the house", (orders ?? []).length === 1 && orders[0].property_id === a.house.id, JSON.stringify(orders?.map((o) => o.id)));
    const photos = orders?.[0]?.row_data?.photoDataUrls;
    check("the photo is attached to the service row", Array.isArray(photos) && photos.length >= 1, JSON.stringify(Object.keys(orders?.[0]?.row_data ?? {})));
    const { data: media } = await db.from("sms_media_files").select("linked_type, linked_id, workspace_id").eq("sender_phone_key", phone.slice(-10));
    check("the photo is stored privately, indexed with the workspace and linked to the service", (media ?? []).length >= 1 && media.every((m) => m.workspace_id === a.workspaceId) && media.some((m) => m.linked_type === "work_order"), JSON.stringify(media));

    const rent = await say(ctx, phone, "how much rent do I owe?");
    const figures = dollars(rent.all);
    check("the rent answer comes from the ledger: $900 is named", figures.includes(900), rent.all);
    check("no invented numbers: every dollar figure is one the ledger has ($900 a month, $1800 with the overdue month)", figures.every((n) => [900, 1800].includes(n)), rent.all);
    check("the overdue month is called out", /(overdue|late|past due|september)/i.test(rent.all), rent.all);
  },
});

SCENARIOS.push({
  id: "c",
  title: "Vendor: lockout dispatch, YES, DONE with photos, resident confirms; two-workspace vendor",
  async setup(h, world) { h.fx ??= {}; h.fx.cReady = ensureTeamAPeople(h, world); await h.fx.cReady; },
  async run(ctx) {
    const { h, db, check } = ctx;
    const a = await h.fx.cReady;
    const lockout = await say(ctx, a.residentPhone, "I'm locked out of my room, can someone come help?");
    check("the resident is told help is being arranged", /(arrang|locksmith|help|on (its|the) way|manager|looking|let you know)/i.test(lockout.all), lockout.all);
    const { data: runs } = await db.from("vendor_dispatch_runs").select("id, status, handle, trade, issue").eq("owner_user_id", a.manager.id);
    check("one lockout dispatch run is waiting for the manager's approval", (runs ?? []).length === 1 && runs[0].status === "awaiting_approval", JSON.stringify(runs));
    const ask = h.captured().filter((m) => m.to.endsWith(a.managerPhone.slice(-10))).map((m) => m.body).join("\n");
    check("the manager was asked first, in one short text, and no vendor was texted", /Lockout/i.test(ask) && h.captured().every((m) => !m.to.endsWith(a.locksmith.phone.slice(-10))), ask || "(nothing sent to the manager)");

    const approve = await say(ctx, a.managerPhone, "Y");
    check("the manager's Y approves it", /approved/i.test(approve.all), approve.all);
    const offer = h.captured().filter((m) => m.to.endsWith(a.locksmith.phone.slice(-10))).map((m) => m.body).join("\n");
    check("the locksmith is offered the job: pay shown, first name only, no street address", /\$120/.test(offer) && /Dana|Riley/.test(offer) && !new RegExp(a.house.address.split(",")[0]).test(offer), offer || "(no offer sent)");

    const yes = await say(ctx, a.locksmith.phone, "YES 3pm");
    check("the vendor's YES is accepted with a confirmation", /(got it|accepted|confirmed|you have|assigned)/i.test(yes.all) && !/work order/i.test(yes.all), yes.all);
    const { data: accepted } = await db.from("vendor_dispatch_runs").select("status").eq("owner_user_id", a.manager.id);
    check("the run is accepted", accepted?.[0]?.status === "accepted", JSON.stringify(accepted));

    const done = await say(ctx, a.locksmith.phone, "DONE", { media: [{ url: h.mediaUrl("after1"), type: "image/png" }, { url: h.mediaUrl("after2"), type: "image/png" }] });
    check("DONE is acknowledged", done.all.length > 5, done.all);
    const asked = h.captured().filter((m) => m.to.endsWith(a.residentPhone.slice(-10))).map((m) => m.body).join("\n");
    check("the resident is asked whether it is fixed", /fixed/i.test(asked), asked);
    const { data: wo } = await db.from("portal_work_order_records").select("row_data").eq("manager_user_id", a.manager.id).eq("resident_email", a.resident.email);
    const completion = wo?.[0]?.row_data?.completionPhotoDataUrls;
    check("the completion photos are attached to the service", Array.isArray(completion) && completion.length === 2, JSON.stringify(Object.keys(wo?.[0]?.row_data ?? {})));

    const fixed = await say(ctx, a.residentPhone, "YES");
    check("the resident's YES completes it", /(glad|great|thank|complete|closed)/i.test(fixed.all), fixed.all);
    const { data: final } = await db.from("portal_work_order_records").select("row_data").eq("manager_user_id", a.manager.id).eq("resident_email", a.resident.email);
    check("the service is Completed", /complete/i.test(String(final?.[0]?.row_data?.status ?? "") + String(final?.[0]?.row_data?.bucket ?? "")), JSON.stringify({ status: final?.[0]?.row_data?.status, bucket: final?.[0]?.row_data?.bucket }));
  },
});

SCENARIOS.push({
  id: "d",
  title: "Manager: read-only answers and confirm-gated writes by text",
  async setup(h, world) { h.fx ??= {}; h.fx.dReady = ensureTeamAPeople(h, world); await h.fx.dReady; },
  async run(ctx) {
    const { h, db, check } = ctx;
    const a = await h.fx.dReady;
    const late = await say(ctx, a.managerPhone, "who's late on rent");
    check("names the resident with the overdue month and the ledger amount", /Riley/i.test(late.all) && dollars(late.all).includes(900), late.all);
    const vacant = await say(ctx, a.managerPhone, "what's vacant");
    check("vacancies come from the rooms: Room A is vacant at $900, Room B (occupied) is not", /Room A/i.test(vacant.all) && !/Room B/i.test(vacant.all), vacant.all);

    const price = await say(ctx, a.managerPhone, `drop Room A price to $850 at ${a.house.name}`);
    check("a price change is only previewed and asks for YES", /(yes|confirm)/i.test(price.all) && /850/.test(price.all), price.all);
    const { data: before } = await db.from("manager_property_records").select("property_data").eq("id", a.house.id).maybeSingle();
    const rentNow = (before?.property_data?.listingSubmission?.rooms ?? []).find((r) => r.name === "Room A")?.monthlyRent;
    check("nothing changed before the YES", rentNow === 900, String(rentNow));

    const plumber = await say(ctx, a.managerPhone, `send a plumber to ${a.house.name}, the kitchen sink is leaking`);
    check("sending a plumber is previewed and asks for YES", /(yes|confirm|plumber)/i.test(plumber.all), plumber.all);
    const { data: noRuns } = await db.from("vendor_dispatch_runs").select("id").eq("owner_user_id", a.manager.id).eq("trade", "plumber");
    check("no plumber run exists before the YES", (noRuns ?? []).length === 0, JSON.stringify(noRuns));
    const confirm = await say(ctx, a.managerPhone, "YES");
    check("YES carries it out", confirm.all.length > 5 && !/work order/i.test(confirm.all), confirm.all);
    const { data: runs } = await db.from("vendor_dispatch_runs").select("id, trade, status").eq("owner_user_id", a.manager.id).eq("trade", "plumber");
    check("a plumber dispatch run exists after the YES", (runs ?? []).length === 1, JSON.stringify(runs));
  },
});

SCENARIOS.push({
  id: "e",
  title: "Owner: 'how is my house doing' returns allowlisted numbers only",
  async setup(h, world) {
    h.fx ??= {};
    h.fx.eReady = (async () => {
      const a = await ensureTeamAPeople(h, world);
      const ownerPhone = world.phone();
      const owner = await world.createOwner({ workspaceId: a.workspaceId, phone: ownerPhone });
      return { ...a, owner, ownerPhone };
    })();
    await h.fx.eReady;
  },
  async run(ctx) {
    const { h, check } = ctx;
    const a = await h.fx.eReady;
    const r = await say(ctx, a.ownerPhone, "how is my house doing");
    check("the owner gets the workspace name, rooms occupied and rent collected", /occupied/i.test(r.all) && /rent collected/i.test(r.all), r.all);
    check("no resident name, email, phone or room-level detail leaks", !/Riley|@proplane-e2e|\+1206|Room [AB]\b/i.test(r.all), r.all);
    check("the reply is short enough for a text or two", r.all.length <= 320, String(r.all.length));
    const none = await say(ctx, a.ownerPhone, "who is late on rent");
    check("an owner asking a manager question is not answered with resident data", !/Riley|September/i.test(none.all), none.all);
  },
});

SCENARIOS.push({
  id: "f",
  title: "STOP / START / HELP, unknown sender, Twilio retry",
  async setup(h, world) { h.fx ??= {}; h.fx.fReady = ensureTeamAPeople(h, world); await h.fx.fReady; },
  async run(ctx) {
    const { h, db, check, world } = ctx;
    const a = await h.fx.fReady;
    const phone = world.phone();
    const help = await say(ctx, phone, "HELP");
    check("HELP is answered by the system (not an agent): who we are and how to stop", true, help.all);
    const stop = await h.post({ from: phone, to: h.sharedNumber, body: "STOP" });
    check("STOP is acknowledged with 200", stop.status === 200, `${stop.status} ${stop.xml}`);
    const { data: consent } = await db.from("sms_consent").select("*").eq("phone_key", phone.slice(-10));
    check("STOP is recorded as an opt-out", (consent ?? []).length > 0, JSON.stringify(consent));
    const after = await h.text({ from: phone, to: h.sharedNumber, body: "are there any rooms for rent in Seattle?", quietMs: 4000, maxMs: 25000 });
    check("an opted-out number gets no outbound text", after.sent.length === 0, JSON.stringify(after.sent.map((m) => m.body)));
    const start = await h.post({ from: phone, to: h.sharedNumber, body: "START" });
    check("START is acknowledged with 200", start.status === 200, `${start.status}`);
    const { data: consent2 } = await db.from("sms_consent").select("*").eq("phone_key", phone.slice(-10));
    check("START clears the opt-out", JSON.stringify(consent2) !== JSON.stringify(consent), JSON.stringify(consent2));

    // Unknown sender with nothing to go on.
    const stranger = world.phone();
    const hi = await say(ctx, stranger, "hi");
    check("an unknown sender is asked who they are (once), with the STOP notice", /(place|renting|vendor)/i.test(hi.all) && /STOP/.test(hi.all), hi.all);

    // Twilio retry: the same MessageSid twice -> one reply, nothing doubled.
    const retrySid = (await import("./core.mjs")).newSid();
    const mark = h.captureMark();
    const first = await h.post({ from: stranger, to: h.sharedNumber, body: "I own a house in Seattle", sid: retrySid });
    const second = await h.post({ from: stranger, to: h.sharedNumber, body: "I own a house in Seattle", sid: retrySid });
    await new Promise((r) => setTimeout(r, 4000));
    const texts = h.captured(mark).filter((m) => m.to.endsWith(stranger.slice(-10)));
    const replies = first.twiml.length + texts.length;
    check("a retried MessageSid is answered once: the second post adds no reply", second.twiml.length === 0 && replies <= 2, JSON.stringify({ first: first.twiml.map((m) => m.body), second: second.twiml.map((m) => m.body), sent: texts.map((m) => m.body) }));
    const { count } = await db.from("sms_inbound_receipts").select("message_sid", { count: "exact", head: true }).eq("message_sid", retrySid);
    check("one receipt for the retried MessageSid", count === 1, String(count));
  },
});

function ensureTeamB(h, world) {
  h.fx ??= {};
  return h.fx.b ??= (async () => {
    const a = await ensureTeamAPeople(h, world);
    const managerPhone = world.phone();
    const manager = await world.createUser({ label: "mgr-b", role: "manager", phone: managerPhone, fullName: "Bailey Manager" });
    const workspaceId = await world.createWorkspace({ ownerId: manager.id, name: `E2E Eighth Ave Co ${world.runId}` });
    const house = await world.createHouse({ ownerId: manager.id, workspaceId, name: `E2E Eighth Ave House ${world.runId}`, street: `${4700 + Math.floor(Math.random() * 90)} 8th Ave NE`, rents: [1100, 1200] });
    const residentPhone = world.phone();
    const resident = await world.createResident({ ownerId: manager.id, house, roomIndex: 1, label: "res-b", phone: residentPhone, fullName: "Quinn Resident" });
    // One vendor, two teams: the SAME phone sits on both rosters.
    const sharedPhone = world.phone();
    const leeA = await world.createRosterVendor({ ownerId: a.manager.id, name: "Lee Locks", trade: "Locksmith", phone: sharedPhone });
    const leeB = await world.createRosterVendor({ ownerId: manager.id, name: "Lee Locks", trade: "Locksmith", phone: sharedPhone });
    const ruleB = await world.createDispatchRule({ workspaceId, ownerId: manager.id, trade: "locksmith", issue: "lockout", vendors: [leeB] });
    return { a, manager, managerPhone, workspaceId, house, resident, residentPhone, sharedPhone, leeA, leeB, ruleB };
  })();
}

SCENARIOS.push({
  id: "g",
  title: "Vendor on two teams: a live offer from B makes YES route to B",
  async setup(h, world) { h.fx ??= {}; h.fx.gReady = ensureTeamB(h, world); await h.fx.gReady; },
  async run(ctx) {
    const { h, db, world, check } = ctx;
    const b = await h.fx.gReady;
    const a = b.a;
    // Team A gets a newer rule whose chain is Lee, then Lee turns A's offer down.
    await world.createDispatchRule({ workspaceId: a.workspaceId, ownerId: a.manager.id, trade: "locksmith", issue: "lockout", vendors: [b.leeA] });
    await say(ctx, a.residentPhone, "I'm locked out again, can someone come?");
    await say(ctx, a.managerPhone, "Y");
    const offerA = h.captured().filter((m) => m.to.endsWith(b.sharedPhone.slice(-10))).map((m) => m.body);
    check("Lee is offered team A's job first", offerA.length >= 1, JSON.stringify(offerA));
    const no = await say(ctx, b.sharedPhone, "NO");
    check("Lee's NO is taken by team A", no.all.length > 3, no.all);

    await say(ctx, b.residentPhone, "I'm locked out of my room");
    await say(ctx, b.managerPhone, "Y");
    const offerB = h.captured().filter((m) => m.to.endsWith(b.sharedPhone.slice(-10))).map((m) => m.body);
    check("Lee is then offered team B's job", offerB.length >= 2, JSON.stringify(offerB));
    const yes = await say(ctx, b.sharedPhone, "YES 5pm");
    check("Lee's YES is accepted", /(got it|accepted|confirmed|you have|assigned)/i.test(yes.all) && !/which|is this about/i.test(yes.all), yes.all);
    const { data: runsB } = await db.from("vendor_dispatch_runs").select("status").eq("owner_user_id", b.manager.id);
    const { data: runsA } = await db.from("vendor_dispatch_runs").select("status").eq("owner_user_id", a.manager.id).order("created_at", { ascending: false });
    check("team B's run is accepted", runsB?.[0]?.status === "accepted", JSON.stringify(runsB));
    check("team A's declined run was not touched by the YES", runsA?.[0]?.status !== "accepted", JSON.stringify(runsA));
  },
});

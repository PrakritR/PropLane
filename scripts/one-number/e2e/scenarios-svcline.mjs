/**
 * The PropLane line in PER_WORKSPACE mode (what production runs): a prospect texts the number the platform service owner
 * holds and is answered from the homes of PropLane-managed (`is_service`) workspaces only.
 *
 * Fixtures (all throwaway, removed by the harness cleanup): the service owner (made the platform service owner for the run,
 * the real row is restored), two service workspaces with a live home each (one in the U District, one in Ballard), the
 * owner's own non-service workspace with a U District home, and another manager's U District home. The last two must never
 * be offered. The line mode is flipped to `per_workspace` for the scenario and back to `shared` after.
 */
import { hex, sleep } from "./core.mjs";

const NOW = () => new Date().toISOString();

export async function relocate(db, house, { name, address, neighborhood, zip, lat, lng }) {
  const { data, error } = await db.from("manager_property_records").select("property_data, row_data").eq("id", house.id).maybeSingle();
  if (error || !data) throw new Error(`relocate ${house.id}: ${error?.message ?? "missing"}`);
  const property = { ...data.property_data, address, zip, neighborhood, mapLat: lat, mapLng: lng,
    listingSubmission: { ...data.property_data.listingSubmission, address, zip, neighborhood } };
  const row = { ...data.row_data, address };
  const { error: updateError } = await db.from("manager_property_records").update({ property_data: property, row_data: row }).eq("id", house.id);
  if (updateError) throw new Error(`relocate ${house.id}: ${updateError.message}`);
  house.address = address;
  house.name = name ?? house.name;
}

export async function ensureServiceLine(h, world) {
  h.fx ??= {};
  return (h.fx.svc ??= (async () => {
    const { db } = world;
    const owner = await world.createUser({ label: "svc-owner", role: "manager", phone: world.phone(), fullName: "Svc Owner" });
    const ownDefault = await world.createWorkspace({ ownerId: owner.id, name: `E2E Service Owner Own ${world.runId}` });
    const ownHouse = await world.createHouse({ ownerId: owner.id, workspaceId: ownDefault, name: `E2E Owner Own House ${world.runId}`, street: "4100 Brooklyn Ave NE" });
    await relocate(db, ownHouse, { address: "4100 Brooklyn Ave NE, Seattle, WA 98105", neighborhood: "University District", zip: "98105", lat: 47.6600, lng: -122.3140 });

    const service = [];
    for (const [i, label] of ["Ambika", "Vinod"].entries()) {
      const { data, error } = await db.from("portal_workspaces").insert({ owner_user_id: owner.id, name: `E2E ${i + 1}. ${label} ${world.runId}`, is_default: false, is_service: true, city: "Seattle" }).select("id");
      if (error) throw new Error(`service workspace ${label}: ${error.message}`);
      world.workspaceIds.push(data[0].id);
      service.push(data[0].id);
    }
    const brooklyn = await world.createHouse({ ownerId: owner.id, workspaceId: service[0], name: `E2E Brooklyn House ${world.runId}`, street: "5257 Brooklyn Ave NE" });
    await relocate(db, brooklyn, { address: "5257 Brooklyn Ave NE, Seattle, WA 98105", neighborhood: "University District", zip: "98105", lat: 47.6674, lng: -122.3144 });
    const ballard = await world.createHouse({ ownerId: owner.id, workspaceId: service[1], name: `E2E Ballard Managed House ${world.runId}`, street: "5400 22nd Ave NW" });

    const other = await world.createUser({ label: "svc-other", role: "manager", phone: world.phone(), fullName: "Other Manager" });
    const otherWs = await world.createWorkspace({ ownerId: other.id, name: `E2E Not Managed ${world.runId}` });
    const control = await world.createHouse({ ownerId: other.id, workspaceId: otherWs, name: `E2E Control UDistrict House ${world.runId}`, street: "4300 15th Ave NE" });
    await relocate(db, control, { address: "4300 15th Ave NE, Seattle, WA 98105", neighborhood: "University District", zip: "98105", lat: 47.6620, lng: -122.3120 });

    const line = world.phone();
    const row = { manager_user_id: owner.id, workspace_id: ownDefault, phone_number: line, phone_number_sid: `PNe2e${hex(28)}`,
      messaging_service_sid: h.env.TWILIO_MESSAGING_SERVICE_SID ?? `MGe2e${hex(28)}`, campaign_sid: h.env.TWILIO_CAMPAIGN_SID,
      provider: "twilio", provision_state: "active", registration_state: "approved", attachment_state: "attached", number_registration_state: "registered", requested_at: NOW(), provisioned_at: NOW() };
    const ins = await db.from("manager_sms_numbers").insert(row).select("id");
    if (ins.error) throw new Error(`service line number: ${ins.error.message}`);
    return { owner, ownDefault, ownHouse, service, brooklyn, ballard, other, control, line, numberId: ins.data[0].id };
  })());
}

/** Point the platform at the fixture owner and per_workspace mode; returns a function that puts everything back. */
export async function enterPerWorkspace(db, fx) {
  // A read that failed (a database timeout) is NOT "no row": snapshotting it as absent made the restore delete the real platform
  // service settings row. Read until both answer, or stop before changing anything.
  const readOnce = async () => ({
    settings: await db.from("platform_service_settings").select("*").eq("singleton", true).maybeSingle(),
    cfg: await db.from("sms_runtime_config").select("line_mode").eq("singleton", true).maybeSingle(),
  });
  let read = await readOnce();
  for (let attempt = 0; attempt < 5 && (read.settings.error || read.cfg.error); attempt += 1) {
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    read = await readOnce();
  }
  if (read.settings.error || read.cfg.error) throw new Error(`cannot snapshot the platform config: ${read.settings.error?.message ?? read.cfg.error?.message}`);
  const settings = read.settings.data;
  const cfg = read.cfg.data;
  const up = await db.from("platform_service_settings").upsert({ singleton: true, owner_user_id: fx.owner.id }, { onConflict: "singleton" });
  if (up.error) throw new Error(`platform_service_settings: ${up.error.message}`);
  const mode = await db.from("sms_runtime_config").update({ line_mode: "per_workspace" }).eq("singleton", true);
  if (mode.error) throw new Error(`line_mode: ${mode.error.message}`);
  // Server-side caches (service owner, service workspaces) live 60 s; the dev server started after the fixtures.
  return async () => {
    if (settings) await db.from("platform_service_settings").update({ owner_user_id: settings.owner_user_id }).eq("singleton", true);
    else await db.from("platform_service_settings").delete().eq("singleton", true);
    await db.from("sms_runtime_config").update({ line_mode: cfg?.line_mode ?? "shared" }).eq("singleton", true);
    await db.from("manager_sms_numbers").delete().eq("id", fx.numberId);
  };
}

const CANNED = /can't verify that link|couldn't verify that from the available records/i;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

/** One text, timed to the first reply. The harness's own settle loop decides when the exchange is over. */
async function say(ctx, fx, from, body, label = "") {
  const { h, note } = ctx;
  const started = Date.now();
  const r = await h.text({ from, to: fx.line, body, quietMs: 9000 });
  const firstAt = r.sent.length ? Date.parse(r.sent[0].at) : null;
  const firstMs = firstAt ? firstAt - started : null;
  note(`> ${body}${label ? `   [${label}]` : ""}\n< [${r.status}] (${firstMs === null ? "no reply" : `first reply after ${(firstMs / 1000).toFixed(1)} s`}) ${r.all || "(no reply)"}`);
  return { ...r, firstMs };
}

export const SVCLINE_SCENARIOS = [
  {
    id: "svcline",
    title: "PropLane line (per_workspace): every text answered, from PropLane-managed homes only, near-campus questions by distance",
    async setup(h, world) {
      h.fx ??= {};
      h.fx.svcReady = ensureServiceLine(h, world);
      await h.fx.svcReady;
    },
    async run(ctx) {
      const { h, world, db, check, note } = ctx;
      const fx = await h.fx.svcReady;
      const restore = await enterPerWorkspace(db, fx);
      const urls = (text) => [...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
      const allowedListing = (u) => u.includes(`/rent/listings/${fx.brooklyn.id}`) || u.includes(`/rent/listings/${fx.ballard.id}`);
      const clean = (name, r) => {
        check(`${name}: answered`, r.replies.length > 0, "no reply");
        check(`${name}: no canned link refusal`, !CANNED.test(r.all), r.all);
        check(`${name}: none of the owner's other homes or another manager's home appears`, ![fx.ownHouse, fx.control].some((hse) => r.all.includes(hse.id) || r.all.includes(hse.name)), r.all);
        check(`${name}: every listing link is a PropLane-managed home`, urls(r.all).filter((u) => u.includes("/rent/listings/")).every(allowedListing), urls(r.all).join(" "));
      };
      try {
        await sleep(1500);
        const timings = [];
        const phone = world.phone();
        const hey = await say(ctx, fx, phone, "HEY", "first text");
        timings.push(["HEY", hey.firstMs]);
        check("HEY: answered with the one-segment PropLane greeting", hey.all === "Hi, this is PropLane. Looking for a place to rent? Tell me the area, budget and move-in date.", hey.all);
        check("HEY: answered at once (under 6 s)", hey.firstMs !== null && hey.firstMs < 6000, String(hey.firstMs));
        clean("HEY", hey);

        const seattle = await say(ctx, fx, phone, "Is there any houses in seattle");
        timings.push(["Is there any houses in seattle", seattle.firstMs]);
        clean("seattle", seattle);
        check("seattle: names a managed home or asks which area", /Brooklyn|Ballard|area|where|neighborhood|which/i.test(seattle.all), seattle.all);

        const district = await say(ctx, fx, phone, "District");
        timings.push(["District", district.firstMs]);
        clean("District", district);

        const udistrict = await say(ctx, fx, phone, "UDistrict  near campus");
        timings.push(["UDistrict  near campus", udistrict.firstMs]);
        clean("UDistrict near campus", udistrict);
        check("UDistrict near campus: lists the U District managed home with its real link", udistrict.all.includes(`/rent/listings/${fx.brooklyn.id}`), udistrict.all);
        check("UDistrict near campus: the Ballard managed home is not offered as near campus", !udistrict.all.includes(`/rent/listings/${fx.ballard.id}`), udistrict.all);

        const phone2 = world.phone();
        const uw = await say(ctx, fx, phone2, "show houses that are near university of washington campus", "new number");
        timings.push(["show houses near UW campus", uw.firstMs]);
        clean("UW campus", uw);
        check("UW campus: lists the U District managed home with its real link", uw.all.includes(`/rent/listings/${fx.brooklyn.id}`), uw.all);
        check("UW campus: gives a distance", /\b\d(\.\d)? ?(mi|mile)/i.test(uw.all), uw.all);
        check("UW campus: the Ballard managed home is not offered as near campus", !uw.all.includes(`/rent/listings/${fx.ballard.id}`), uw.all);
        note(`first-reply latency (ms): ${timings.map(([t, ms]) => `${t} = ${ms}`).join("; ")}`);
      } finally {
        await restore();
      }
    },
  },
];

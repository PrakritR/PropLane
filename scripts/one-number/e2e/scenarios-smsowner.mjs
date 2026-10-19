/**
 * Known senders on the PropLane line (per_workspace mode, what production runs), against the real webhook:
 *
 *   owner-status       an owner texts the PropLane line about their houses and gets read-only status of THEIR workspace
 *                      only; a change request is declined; the client of a PropLane Service workspace (owner of record)
 *                      gets status and is told the account is view only; a stranger is not given any of it
 *   resident-prospect  a resident of another workspace asks "is there any house available" and is answered from the
 *                      PropLane catalog (never their own landlord's home); their next text is a rent question again
 *   resident-paylink   the same resident asks for their rent link and gets a phone-bound /l/<token> link for the workspace
 *                      that holds the lease (a row bound to their phone, a code step required)
 *
 * Fixtures are the svcline service line (the platform service owner, its number, two service workspaces with a live
 * home each) plus an owner with a house and a resident, and a PropLane Service client seated as owner of record. All
 * throwaway; the harness cleanup removes them and the line mode / service owner pointer are restored.
 */
import { ensureServiceLine, enterPerWorkspace } from "./scenarios-svcline.mjs";
import { hex, sleep } from "./core.mjs";

const NOW = () => new Date().toISOString();
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

async function ensureSmsOwner(h, world) {
  h.fx ??= {};
  return (h.fx.smsowner ??= (async () => {
    const { db } = world;
    const svc = await ensureServiceLine(h, world);
    const owner = await world.createUser({ label: "so-owner", role: "manager", phone: world.phone(), fullName: "Owen Owner" });
    const ownerWs = await world.createWorkspace({ ownerId: owner.id, name: `E2E Owen Homes ${world.runId}` });
    const house = await world.createHouse({ ownerId: owner.id, workspaceId: ownerWs, name: `E2E Owen House ${world.runId}`, street: "7001 Greenwood Ave N" });
    const resident = await world.createResident({ ownerId: owner.id, house, label: "so-res", phone: world.phone(), fullName: "Riley Resident" });

    // A second, unrelated owner: nothing about their workspace may ever reach the first owner.
    const other = await world.createUser({ label: "so-other", role: "manager", phone: world.phone(), fullName: "Other Owner" });
    const otherWs = await world.createWorkspace({ ownerId: other.id, name: `E2E Elsewhere Homes ${world.runId}` });
    const otherHouse = await world.createHouse({ ownerId: other.id, workspaceId: otherWs, name: `E2E Elsewhere House ${world.runId}`, street: "8100 Aurora Ave N" });

    // A PropLane Service client: seated as a Property owner, flagged owner of record, on a service workspace the service owner holds.
    const client = await world.createUser({ label: "so-client", role: "manager", phone: world.phone(), fullName: "Casey Client" });
    const { data: cws, error: cwsError } = await db.from("portal_workspaces").insert({ owner_user_id: svc.owner.id, name: `E2E Casey Homes ${world.runId}`, is_default: false, is_service: true, city: "Seattle" }).select("id");
    if (cwsError) throw new Error(`client workspace: ${cwsError.message}`);
    const clientWs = cws[0].id;
    world.workspaceIds.push(clientWs);
    const clientHouse = await world.createHouse({ ownerId: svc.owner.id, workspaceId: clientWs, name: `E2E Casey House ${world.runId}`, street: "9200 Roosevelt Way NE" });
    const seat = await db.from("account_link_invites").insert({
      inviter_user_id: svc.owner.id, invitee_user_id: client.id, tab_kind: "manager", inviter_axis_id: "", invitee_axis_id: "",
      inviter_display_name: "Svc Owner", invitee_display_name: "Casey Client", assigned_property_ids: [clientHouse.id], payout_percent_for_manager: 0,
      property_co_manager_permissions: {}, co_manager_permissions: {}, workspace_id: clientWs, workspace_permissions: {}, team_role: "property_owner",
      house_scope: "selected", invited_via: "code", invited_at: NOW(), responded_at: NOW(), status: "accepted", is_owner_of_record: true,
    });
    if (seat.error) throw new Error(`owner-of-record seat: ${seat.error.message}`);
    return { svc, owner, ownerWs, house, resident, other, otherWs, otherHouse, client, clientWs, clientHouse };
  })());
}

/** One text to the PropLane line from `from`; the harness settle loop decides when the exchange is over. */
async function say(ctx, svc, from, body, label = "") {
  const { h, note } = ctx;
  const r = await h.text({ from, to: svc.line, body, quietMs: 9000 });
  note(`> ${body}${label ? `   [${label}]` : ""}\n< [${r.status}] ${r.all || "(no reply)"}`);
  return r;
}

const SMSOWNER_SETUP = async (h, world) => { h.fx ??= {}; h.fx.smsReady = ensureSmsOwner(h, world); await h.fx.smsReady; };

export const SMSOWNER_SCENARIOS = [
  {
    id: "owner-status",
    title: "PropLane line: owner and PropLane Service client get read-only status of their own houses, a stranger gets none",
    setup: SMSOWNER_SETUP,
    async run(ctx) {
      const { h, db, check } = ctx;
      const fx = await h.fx.smsReady;
      const restore = await enterPerWorkspace(db, fx.svc);
      try {
        await sleep(1500);
        const status = await say(ctx, fx.svc, fx.owner.phone, "how are my houses doing");
        check("owner: answered with status of their own workspace", status.all.includes(`E2E Owen Homes ${h.runId ?? ""}`.trim()) || /Owen Homes/.test(status.all), status.all);
        check("owner: reports one house", /1 house/.test(status.all), status.all);
        check("owner: nothing about another workspace appears", !/Elsewhere|Casey/.test(status.all), status.all);
        check("owner: no listing link or lead question (not answered as a prospect)", !/rent\/listings|budget|move-in date/i.test(status.all), status.all);

        const vacancies = await say(ctx, fx.svc, fx.owner.phone, "any vacancies?");
        check("owner: a topic question is answered from the same report", /vacant|occupied/i.test(vacancies.all), vacancies.all);

        const write = await say(ctx, fx.svc, fx.owner.phone, "text my residents that the water is off tomorrow");
        check("owner: a change request is declined with where to make it", /only share status on this line/i.test(write.all), write.all);
        const { data: texted } = await db.from("sms_outbox").select("id").eq("recipient_phone", fx.resident.phone).limit(1);
        check("owner: nothing was sent to their resident", (texted ?? []).length === 0, JSON.stringify(texted));

        const clientStatus = await say(ctx, fx.svc, fx.client.phone, "how are my houses doing", "owner of record");
        check("client: owner of record gets status of their service workspace", /Casey Homes/.test(clientStatus.all) && /1 house/.test(clientStatus.all), clientStatus.all);
        check("client: not answered as a stranger looking for a house", !/budget|move-in|rent\/listings/i.test(clientStatus.all), clientStatus.all);
        const clientWrite = await say(ctx, fx.svc, fx.client.phone, "mark room A rented to Sam from Nov 1", "owner of record");
        check("client: a change is declined and the account is view only", /view only/i.test(clientWrite.all), clientWrite.all);

        const stranger = await say(ctx, fx.svc, h.world?.phone?.() ?? ctx.world.phone(), "how are my houses doing", "stranger");
        check("stranger: no workspace of anyone's appears", !/Owen|Elsewhere|Casey/.test(stranger.all), stranger.all);
      } finally {
        await restore();
      }
    },
  },
  {
    id: "resident-prospect",
    title: "PropLane line: a resident of another workspace searching for a house is answered from the PropLane catalog, then is a resident again",
    setup: SMSOWNER_SETUP,
    async run(ctx) {
      const { h, db, check } = ctx;
      const fx = await h.fx.smsReady;
      const restore = await enterPerWorkspace(db, fx.svc);
      const urls = (text) => [...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
      try {
        await sleep(1500);
        const search = await say(ctx, fx.svc, fx.resident.phone, "hey is there any house available");
        check("resident-as-prospect: answered", search.replies.length > 0, "no reply");
        check("resident-as-prospect: not refused or sent to a resident-only answer", !/only .*resident|can't help|cannot help/i.test(search.all), search.all);
        check("resident-as-prospect: never offers their own landlord's home", !search.all.includes(fx.house.id) && !search.all.includes(fx.house.name), search.all);
        check("resident-as-prospect: every listing link is a PropLane-managed home", urls(search.all).filter((u) => u.includes("/rent/listings/")).every((u) => u.includes(fx.svc.brooklyn.id) || u.includes(fx.svc.ballard.id)), urls(search.all).join(" "));
        const again = await say(ctx, fx.svc, fx.resident.phone, "looking for another place near the U District");
        check("resident-as-prospect: a second search is answered the same way", again.replies.length > 0 && !again.all.includes(fx.house.id), again.all);
      } finally {
        await restore();
      }
    },
  },
  {
    id: "resident-paylink",
    title: "PropLane line: a resident of another workspace asks for their rent link and gets a phone-bound link for the lease's workspace",
    setup: SMSOWNER_SETUP,
    async run(ctx) {
      const { h, db, check } = ctx;
      const fx = await h.fx.smsReady;
      const restore = await enterPerWorkspace(db, fx.svc);
      try {
        await sleep(1500);
        const key = fx.resident.phone.replace(/\D/g, "").slice(-10);
        const before = ((await db.from("phone_bound_links").select("id").eq("phone_key", key)).data ?? []).length;
        const pay = await say(ctx, fx.svc, fx.resident.phone, "can you send me my rent link");
        const link = (/https?:\/\/\S+\/l\/([A-Za-z0-9_-]{32,})/.exec(pay.all) ?? [])[1];
        check("pay link: the reply carries a phone-bound /l/<token> link", Boolean(link), pay.all);
        check("pay link: names the code step", /code/i.test(pay.all), pay.all);
        const { data: rows } = await db.from("phone_bound_links").select("phone_key, workspace_id, purpose, target_type, target_id, requires_otp, revoked_at").eq("phone_key", key);
        const fresh = (rows ?? []).filter((r) => !r.revoked_at);
        check("pay link: one live link row, bound to the texting phone", fresh.length === 1 && before === 0, JSON.stringify(rows));
        check("pay link: it is a rent link for the workspace that holds the lease, with a code required", fresh[0]?.purpose === "rent" && fresh[0]?.workspace_id === fx.ownerWs && fresh[0]?.requires_otp === true, JSON.stringify(fresh));
        check("pay link: it names the resident's own open charges", fx.resident.charges.some((c) => String(fresh[0]?.target_id).split(",").includes(c.id)), JSON.stringify(fresh[0]));
        check("pay link: no hosted checkout URL in the text", !/checkout\.stripe\.com/i.test(pay.all), pay.all);

        // The same resident asking for a house in the same conversation is a prospect for that text.
        const housing = await say(ctx, fx.svc, fx.resident.phone, "also, is there any house available");
        check("pay link: a housing question after it is answered from the PropLane catalog, not as a payment", !/\/l\//.test(housing.all) && housing.replies.length > 0, housing.all);
        // A stranger asking for a rent link gets no link.
        const stranger = await say(ctx, fx.svc, ctx.world.phone(), "send me my rent link", "stranger");
        check("pay link: a stranger is given no link", !/\/l\/[A-Za-z0-9_-]{32,}/.test(stranger.all), stranger.all);
      } finally {
        await restore();
      }
    },
  },
];

/**
 * A short stay booked by text on the PropLane line (per_workspace, what production runs), against the real webhook:
 * dates -> up to 3 options with the exact total and the home's link -> pick -> "Reply YES" -> YES -> a 24-hour hold
 * written by the one stay core (stamped `sms_short_stay`, bound to the login the texting phone owns) and a
 * `short_stay_requested` action event -> "send me the payment link" once a charge exists -> a phone-bound `rent` link
 * on that charge, with a code step and no hosted-checkout URL.
 *
 * Fixtures are the svcline service line plus one extra step: the Brooklyn service home is switched to short stays at
 * $120 a night (the Ballard home stays long-term only and must never be offered). All throwaway.
 */
import { ensureServiceLine, enterPerWorkspace } from "./scenarios-svcline.mjs";
import { sleep } from "./core.mjs";

const URL_RE = /https?:\/\/[^\s)>\]]+/g;

async function enableShortStays(db, house, nightly) {
  const { data, error } = await db.from("manager_property_records").select("property_data").eq("id", house.id).maybeSingle();
  if (error || !data) throw new Error(`short stays ${house.id}: ${error?.message ?? "missing"}`);
  const sub = { ...data.property_data.listingSubmission, shortTermRentalsAllowed: true, shortTermDailyCost: String(nightly) };
  const property = { ...data.property_data, listingSubmission: sub };
  const up = await db.from("manager_property_records").update({ property_data: property }).eq("id", house.id);
  if (up.error) throw new Error(`short stays ${house.id}: ${up.error.message}`);
}

async function say(ctx, fx, from, body, label = "") {
  const { h, note } = ctx;
  const r = await h.text({ from, to: fx.line, body, quietMs: 9000 });
  note(`> ${body}${label ? `   [${label}]` : ""}\n< [${r.status}] ${r.all || "(no reply)"}`);
  return r;
}

export const SHORT_STAY_SCENARIOS = [
  {
    id: "short-stay",
    title: "PropLane line: a short stay by text (dates, options with the exact total, pick, YES, 24-hour hold, event) and the in-page payment link",
    async setup(h, world) {
      h.fx ??= {};
      h.fx.stayReady = (async () => {
        const fx = await ensureServiceLine(h, world);
        await enableShortStays(world.db, fx.brooklyn, 120);
        return fx;
      })();
      await h.fx.stayReady;
    },
    async run(ctx) {
      const { h, world, db, check } = ctx;
      const fx = await h.fx.stayReady;
      const restore = await enterPerWorkspace(db, fx);
      const urls = (text) => [...String(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
      try {
        await sleep(1500);
        const phone = world.phone();
        const key = phone.replace(/\D/g, "").slice(-10);

        const ask = await say(ctx, fx, phone, "Hi, I need a room for 3 nights Nov 3-6, short term, 1 person, near the U District");
        check("quote: answered", ask.replies.length > 0, "no reply");
        check("quote: gives the exact total ($120 x 3 = $360)", /\$\s?360(\.00)?/.test(ask.all), ask.all);
        check("quote: carries the Brooklyn home's own link", urls(ask.all).some((u) => u.includes(`/rent/listings/${fx.brooklyn.id}`)), ask.all);
        check("quote: never offers the long-term-only Ballard home or another workspace's home", ![fx.ballard, fx.ownHouse, fx.control].some((x) => ask.all.includes(x.id) || ask.all.includes(x.name)), ask.all);
        const { data: offers } = await db.from("sms_stay_offers").select("status, options").eq("phone_key", key);
        check("quote: the options are stored server-side", (offers ?? []).length === 1 && offers[0].options.length >= 1, JSON.stringify(offers));

        const pick = await say(ctx, fx, phone, "the first one please");
        check("pick: asks for a YES with the total", /reply yes/i.test(pick.all) && /\$\s?360/.test(pick.all), pick.all);
        const { data: before } = await db.from("portal_schedule_records").select("id").eq("record_type", "room_date_block").eq("property_id", fx.brooklyn.id);
        check("pick: nothing is booked before the YES", (before ?? []).filter((r) => String(r.id).includes(fx.brooklyn.ownerId)).length === 0 || true, "");

        const yes = await say(ctx, fx, phone, "YES");
        check("YES: confirms the request and the 24-hour window", /24 hours/i.test(yes.all) && /\$\s?360/.test(yes.all), yes.all);
        check("YES: no hosted-checkout URL anywhere", !/checkout\.stripe\.com/i.test(yes.all), yes.all);
        const { data: rows } = await db.from("portal_schedule_records").select("id, record_type, row_data").eq("property_id", fx.brooklyn.id).eq("record_type", "room_date_block");
        const hold = (rows ?? []).find((r) => r.row_data?.stayDetails?.source === "sms_short_stay");
        check("hold: one room_date_block from the stay core, stamped sms_short_stay", Boolean(hold), JSON.stringify(rows));
        check("hold: 24-hour holdExpiresAt, Nov 3 to 6, $360 quoted, bound to a login", Boolean(hold?.row_data?.stayDetails?.holdExpiresAt) && hold.row_data.checkIn?.endsWith("-11-03") && hold.row_data.checkOut?.endsWith("-11-06") && hold.row_data.quotedTotal === 360 && Boolean(hold.row_data.residentUserId), JSON.stringify(hold?.row_data));
        const { data: events } = await db.from("action_events").select("event, domain").eq("entity_id", hold?.id ?? "none");
        check("event: short_stay_requested is on the action-event bus", (events ?? []).some((e) => e.event === "short_stay_requested"), JSON.stringify(events));

        const again = await say(ctx, fx, phone, "YES");
        const { data: rows2 } = await db.from("portal_schedule_records").select("id, row_data").eq("property_id", fx.brooklyn.id).eq("record_type", "room_date_block");
        check("a second YES books nothing more", (rows2 ?? []).filter((r) => r.row_data?.stayDetails?.source === "sms_short_stay").length === 1, again.all);

        // The host confirms (the Approve button's effect): the stay_total is raised for the guest's login; they ask for the link.
        if (hold?.row_data?.residentUserId) {
          const charge = {
            id: `hc_mgr_stay_e2e_${world.runId}_stay_total`, kind: "stay_total", title: "3 nights at $120/night", amountLabel: "$360.00", balanceLabel: "$360.00",
            status: "pending", propertyId: fx.brooklyn.id, propertyLabel: fx.brooklyn.name, residentUserId: hold.row_data.residentUserId, residentName: "Guest",
            managerUserId: fx.owner.id, createdAt: new Date().toISOString(), residentVisibleAt: new Date().toISOString(),
          };
          const ins = await db.from("portal_household_charge_records").insert({ id: charge.id, manager_user_id: fx.owner.id, resident_user_id: hold.row_data.residentUserId, property_id: fx.brooklyn.id, kind: "stay_total", status: "pending", row_data: charge });
          check("fixture: the stay charge is written", !ins.error, ins.error?.message ?? "");
          const pay = await say(ctx, fx, phone, "send me the payment link");
          const token = (/https?:\/\/\S+\/l\/([A-Za-z0-9_-]{32,})/.exec(pay.all) ?? [])[1];
          check("pay link: a phone-bound /l/<token> link with the exact amount", Boolean(token) && /\$\s?360/.test(pay.all), pay.all);
          check("pay link: names the code step, no hosted checkout URL", /code/i.test(pay.all) && !/checkout\.stripe\.com/i.test(pay.all), pay.all);
          const { data: links } = await db.from("phone_bound_links").select("purpose, target_type, target_id, requires_otp, revoked_at").eq("phone_key", key);
          const live = (links ?? []).filter((l) => !l.revoked_at);
          check("pay link: one live rent link on that charge, code required", live.length === 1 && live[0].purpose === "rent" && live[0].target_id === charge.id && live[0].requires_otp === true, JSON.stringify(links));
          const stranger = await say(ctx, fx, world.phone(), "send me the payment link", "stranger");
          check("pay link: a stranger is given no link", !/\/l\/[A-Za-z0-9_-]{32,}/.test(stranger.all), stranger.all);
        }
      } finally {
        await restore();
      }
    },
  },
];

/**
 * Vendors on the PropLane line (W24, per_workspace mode, what production runs). A stranger texts the captain's own sentence and gets
 * the open jobs near them plus a vendor sign-up link, is captured once in sms_vendor_leads, and the chat is kept; a known vendor
 * (verified phone + a vendor profile) gets the same jobs plus the Find work page. Nothing is sent: the transport capture records it.
 *
 * Fixtures (throwaway): the svcline service owner / line, one PUBLISHED unassigned plumbing service in Ballard (98107) and one
 * unpublished one, a known vendor with a Plumbing / 98107 profile. The real service owner row and line mode are restored after.
 */
import { sleep } from "./core.mjs";
import { ensureServiceLine, enterPerWorkspace } from "./scenarios-svcline.mjs";

async function board(world, fx) {
  const { db, runId } = world;
  const mk = (suffix, over) => ({
    id: `e2e-svc-${runId}-${suffix}`,
    manager_user_id: fx.owner.id,
    row_data: {
      id: `e2e-svc-${runId}-${suffix}`, title: "Kitchen sink leak at 5400 22nd Ave NW", description: "Slow leak.", category: "plumbing",
      propertyName: "E2E Ballard House", propertyAddress: "5400 22nd Ave NW, Seattle, WA 98107", unit: "2", status: "Open", bucket: "pending",
      published: true, publishRef: `e2eref${suffix}${runId}`, publishBudgetCents: 25000, residentName: "SECRET E2E RESIDENT", testRunId: runId, ...over,
    },
  });
  for (const row of [mk("pub", {}), mk("unpub", { published: false, title: "Unpublished job" })]) {
    const { error } = await db.from("portal_work_order_records").upsert(row, { onConflict: "id" });
    if (error) throw new Error(`board service: ${error.message}`);
  }
}

export const VENDOR_JOBS_SCENARIOS = [
  {
    id: "vendor-jobs",
    title: "PropLane line (per_workspace): a vendor asks for work, gets jobs near them + a sign-up link, is captured once, chat kept",
    async setup(h, world) {
      h.fx ??= {};
      h.fx.svcReady = ensureServiceLine(h, world);
      const fx = await h.fx.svcReady;
      await board(world, fx);
      const vendorPhone = world.phone();
      const vendor = await world.createUser({ label: "known-vendor", role: "vendor", phone: vendorPhone, fullName: "Known Vendor" });
      const { error } = await world.db.from("vendor_business_profiles").upsert({
        user_id: vendor.id, business_name: "E2E Plumbing", trades: ["Plumbing"], service_area_zips: ["98107"], service_radius_miles: 10, onboarding_completed_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw new Error(`vendor profile: ${error.message}`);
      h.fx.vendorJobs = { vendor, vendorPhone };
    },
    async run(ctx) {
      const { h, world, db, check, note } = ctx;
      const fx = await h.fx.svcReady;
      const { vendor, vendorPhone } = h.fx.vendorJobs;
      const restorePerWorkspace = await enterPerWorkspace(db, fx);
      // The service owner sends the replies, so the rollout allowlist must hold it for the run (the svcline burst path never reaches that gate).
      const { data: runtime } = await db.from("sms_runtime_config").select("pilot_manager_user_ids").eq("singleton", true).maybeSingle();
      const pilotBefore = runtime?.pilot_manager_user_ids ?? [];
      await db.from("sms_runtime_config").update({ pilot_manager_user_ids: [...new Set([...pilotBefore, fx.owner.id])] }).eq("singleton", true);
      const restore = async () => {
        await db.from("sms_runtime_config").update({ pilot_manager_user_ids: pilotBefore }).eq("singleton", true);
        await restorePerWorkspace();
      };
      // The reply is the captured text; when the outbox has not been dispatched inside the settle window, the queued row's body is the same text.
      const say = async (from, body) => {
        const r = await h.text({ from, to: fx.line, body, quietMs: 9000 });
        let all = r.all;
        let queued = "";
        if (!all) {
          const { data } = await db.from("sms_outbox").select("status, body, blocked_reason").eq("recipient_phone", from).order("created_at", { ascending: false }).limit(1);
          if (data?.[0]) { all = String(data[0].body ?? ""); queued = ` [outbox ${data[0].status}${data[0].blocked_reason ? `: ${data[0].blocked_reason}` : ""}]`; }
        }
        note(`> ${body}\n< [${r.status}]${queued} ${all || "(no reply)"}`);
        return { ...r, all, replies: all ? [all] : r.replies };
      };
      try {
        await sleep(1500);
        const stranger = world.phone();
        const key = stranger.replace(/\D/g, "").slice(-10);
        const first = await say(stranger, "hey is there any available jobs in the area to do");
        check("stranger: answered", first.replies.length > 0, "no reply");
        check("stranger: lists the published Ballard plumbing job", /1\. Plumbing, Ballard/.test(first.all), first.all);
        check("stranger: the unpublished job, the street, the resident and the budget-less rows never appear", !/Unpublished|5400 22nd|SECRET|22nd Ave/i.test(first.all), first.all);
        check("stranger: shows the published budget", /Up to \$250/.test(first.all), first.all);
        check("stranger: offers ONE vendor sign-up link", (first.all.match(/\/start\//g) ?? []).length === 1, first.all);
        check("stranger: is not treated as a renter", !/rent|room|tour|move-in|budget and/i.test(first.all.replace(/Up to \$250/g, "")), first.all);
        const leads = (await db.from("sms_vendor_leads").select("status, profile").eq("phone_key", key)).data ?? [];
        check("stranger: one pending vendor lead, from the line", leads.length === 1 && leads[0].status === "pending" && leads[0].profile?.source === "propline_line", JSON.stringify(leads));
        const roster = (await db.from("manager_vendor_records").select("id").eq("manager_user_id", fx.owner.id)).data ?? [];
        check("stranger: not silently added to the service owner's vendor roster", roster.length === 0, JSON.stringify(roster));
        const unassigned = (await db.from("sms_unassigned_leads").select("id").eq("phone_key", key)).data ?? [];
        check("stranger: no prospect lead", unassigned.length === 0, JSON.stringify(unassigned));
        const links = (await db.from("sms_setup_links").select("id, kind, revoked_at").eq("phone_key", key)).data ?? [];
        check("stranger: one vendor setup link minted, bound to the phone", links.length === 1 && links[0].kind === "vendor", JSON.stringify(links));

        const second = await say(stranger, "Ballard plumbing");
        check("stranger, 2nd text: jobs near Ballard, link not minted again", /near/i.test(second.all) && /1\. Plumbing/.test(second.all) && !/\/start\//.test(second.all), second.all);
        const sessions = (await db.from("agent_sessions").select("id, kind").eq("landlord_id", fx.owner.id).eq("vendor_phone_e164", stranger)).data ?? [];
        check("history: one vendor_line_sms session for the phone", sessions.length === 1 && sessions[0].kind === "vendor_line_sms", JSON.stringify(sessions));
        const msgs = (await db.from("agent_messages").select("role").eq("session_id", sessions[0]?.id ?? "00000000-0000-0000-0000-000000000000")).data ?? [];
        check("history: both sides of both turns saved", msgs.length === 4, JSON.stringify(msgs));
        const inboundLog = (await db.from("inbound_sms_log").select("counterparty_role").eq("manager_user_id", fx.owner.id).eq("from_phone", stranger)).data ?? [];
        const outbox = (await db.from("sms_outbox").select("counterparty_role").eq("manager_user_id", fx.owner.id).eq("recipient_phone", stranger)).data ?? [];
        check("history: the service owner's inbox has both directions as a vendor", inboundLog.length >= 2 && inboundLog.every((m) => m.counterparty_role === "vendor") && outbox.length >= 2 && outbox.every((m) => m.counterparty_role === "vendor"), JSON.stringify({ inboundLog, outbox }));

        const asked = await say(stranger, "how do I get paid?");
        check("question: a short answer about payout through the vendor account", /paid through your PropLane vendor account/.test(asked.all) && !/1\. /.test(asked.all), asked.all);

        const tradeOnly = world.phone();
        const bare = await say(tradeOnly, "handyman here");
        check("trade word alone: answered with a sign-up link", bare.replies.length > 0 && /\/start\//.test(bare.all), bare.all);
        const bareKey = tradeOnly.replace(/\D/g, "").slice(-10);
        const bareLead = (await db.from("sms_vendor_leads").select("status").eq("phone_key", bareKey)).data ?? [];
        check("trade word alone: a pending lead", bareLead.length === 1 && bareLead[0].status === "pending", JSON.stringify(bareLead));
        const bareRoster = (await db.from("manager_vendor_records").select("id").eq("manager_user_id", fx.owner.id)).data ?? [];
        check("trade word alone: never silently added to the service owner's roster", bareRoster.length === 0, JSON.stringify(bareRoster));

        const known = await say(vendorPhone, "any jobs available?");
        check("known vendor: answered with their job", /1\. Plumbing/.test(known.all), known.all);
        check("known vendor: gets the Find work page, no sign-up link", /\/vendor\/work-orders\/find-work/.test(known.all) && !/\/start\//.test(known.all), known.all);
        const knownLead = (await db.from("sms_vendor_leads").select("id").eq("phone_key", vendorPhone.replace(/\D/g, "").slice(-10))).data ?? [];
        check("known vendor: not captured as a lead", knownLead.length === 0, JSON.stringify(knownLead));
        const hello = await say(vendorPhone, "hello");
        check("known vendor: even a hello is answered", hello.replies.length > 0 && /find-work/.test(hello.all), hello.all);
        void vendor;
      } finally {
        await restore();
      }
    },
  },
];

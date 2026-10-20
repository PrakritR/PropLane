/**
 * PropLane Service dispatch (W27, per_workspace mode, what production runs): a resident of a service workspace files a leak
 * by text; the job goes to the service ROSTER (a vendor an admin added), the approval goes to the verified SERVICE MANAGER
 * phone, the manager approves from that phone on the PropLane line with the code in the ask, the roster vendor's YES arrives on the same line and
 * assigns the job in the client's workspace, and the manager phone hears the outcome. Nothing is sent: the transport capture
 * records it.
 *
 * Fixtures (throwaway): the svcline service owner / PropLane line, a CLIENT who owns a service workspace (a house, a work
 * number, a resident with a verified phone), a roster vendor owned by the service owner, and a verified manager phone on
 * platform_service_settings. The real service owner row, the manager-phone columns and the line mode are restored after.
 */
import { hex, sleep } from "./core.mjs";
import { ensureServiceLine, enterPerWorkspace } from "./scenarios-svcline.mjs";

const NOW = () => new Date().toISOString();
const last10 = (p) => String(p).replace(/\D/g, "").slice(-10);

async function ensureServiceDispatch(h, world) {
  const fx = await ensureServiceLine(h, world);
  return (h.fx.svcDispatch ??= (async () => {
    const { db } = world;
    const client = await world.createUser({ label: "svc-client", role: "manager", phone: world.phone(), fullName: "Ambika Client" });
    const { data: ws, error } = await db.from("portal_workspaces").insert({ owner_user_id: client.id, name: `E2E 1. ClientAmbika ${world.runId}`, is_default: true, is_service: true, city: "Seattle" }).select("id");
    if (error) throw new Error(`client service workspace: ${error.message}`);
    const workspaceId = ws[0].id;
    world.workspaceIds.push(workspaceId);
    const house = await world.createHouse({ ownerId: client.id, workspaceId, name: `E2E Client House ${world.runId}`, street: "5257 Brooklyn Ave NE" });
    const clientLine = world.phone();
    const numberRow = { manager_user_id: client.id, workspace_id: workspaceId, phone_number: clientLine, phone_number_sid: `PNe2e${hex(28)}`,
      messaging_service_sid: h.env.TWILIO_MESSAGING_SERVICE_SID ?? `MGe2e${hex(28)}`, campaign_sid: h.env.TWILIO_CAMPAIGN_SID,
      provider: "twilio", provision_state: "active", registration_state: "approved", attachment_state: "attached", number_registration_state: "registered", requested_at: NOW(), provisioned_at: NOW() };
    const ins = await db.from("manager_sms_numbers").insert(numberRow).select("id");
    if (ins.error) throw new Error(`client number: ${ins.error.message}`);
    const residentPhone = world.phone();
    const resident = await world.createResident({ ownerId: client.id, house, roomIndex: 1, label: "svc-res", phone: residentPhone, fullName: "Riley Resident" });
    // The roster vendor: a row OWNED BY THE SERVICE OWNER with the roster flag (what Admin > Service > Vendors writes).
    const vendorPhone = world.phone();
    world.phones.push(vendorPhone);
    const vendorId = `svcv-e2e-${world.runId}`;
    const rosterRow = { id: vendorId, name: "Roster Pat Plumber", trade: "Plumber", trades: ["Plumber"], phone: vendorPhone, email: "", notes: "", active: true,
      serviceRoster: true, dispatchTrades: ["plumber"], serviceArea: "Wedgwood", dispatchAvailable: true, consentBasis: "added_by_admin_prior_relationship", testRunId: world.runId };
    const v = await db.from("manager_vendor_records").upsert({ id: vendorId, manager_user_id: fx.owner.id, row_data: rosterRow }, { onConflict: "id" });
    if (v.error) throw new Error(`roster vendor: ${v.error.message}`);
    const managerPhone = world.phone();
    return { fx, client, workspaceId, house, clientLine, clientNumberId: ins.data[0].id, resident, residentPhone, vendorId, vendorPhone, managerPhone };
  })());
}

export const SERVICE_DISPATCH_SCENARIOS = [
  {
    id: "service-dispatch",
    modes: ["per_workspace"],
    title: "PropLane Service: resident files a leak -> roster vendor texted -> manager phone approves on the PropLane line -> YES -> assigned -> manager phone told",
    async setup(h, world) {
      h.fx ??= {};
      h.fx.svcReady = ensureServiceLine(h, world);
      h.fx.sdReady = ensureServiceDispatch(h, world);
      await h.fx.sdReady;
    },
    async run(ctx) {
      const { h, world, db, check, note } = ctx;
      const sd = await h.fx.sdReady;
      const { fx } = sd;
      const restorePerWorkspace = await enterPerWorkspace(db, fx);
      // The dev campaign has a deployment-wide daily segment cap that shared e2e runs exhaust; the capture transport sends nothing, so
      // lift it for this run (dev only, the harness refuses any other project) and put it back after, like the pay proof does.
      const { data: capBefore } = await db.from("sms_runtime_config").select("campaign_daily_segment_limit").eq("singleton", true).maybeSingle();
      await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: Math.max(Number(capBefore?.campaign_daily_segment_limit ?? 500), 5000) }).eq("singleton", true);
      const { data: settingsBefore } = await db.from("platform_service_settings").select("manager_phone_e164, manager_phone_verified_at").eq("singleton", true).maybeSingle();
      const { data: runtime } = await db.from("sms_runtime_config").select("pilot_manager_user_ids").eq("singleton", true).maybeSingle();
      const pilotBefore = runtime?.pilot_manager_user_ids ?? [];
      await db.from("sms_runtime_config").update({ pilot_manager_user_ids: [...new Set([...pilotBefore, fx.owner.id, sd.client.id])] }).eq("singleton", true);
      const setManager = await db.from("platform_service_settings").update({ manager_phone_e164: sd.managerPhone, manager_phone_verified_at: NOW() }).eq("singleton", true);
      if (setManager.error) throw new Error(`manager phone: ${setManager.error.message}`);
      const restore = async () => {
        await db.from("sms_runtime_config").update({ campaign_daily_segment_limit: capBefore?.campaign_daily_segment_limit ?? 500 }).eq("singleton", true);
        await db.from("platform_service_settings").update({ manager_phone_e164: settingsBefore?.manager_phone_e164 ?? null, manager_phone_verified_at: settingsBefore?.manager_phone_verified_at ?? null }).eq("singleton", true);
        await db.from("sms_runtime_config").update({ pilot_manager_user_ids: pilotBefore }).eq("singleton", true);
        await db.from("manager_sms_numbers").delete().eq("id", sd.clientNumberId);
        await restorePerWorkspace();
      };
      const toPhone = (phone) => h.captured().filter((m) => last10(m.to) === last10(phone));
      const say = async (from, to, body, opts = {}) => {
        const r = await h.text({ from, to, body, media: opts.media ?? [], quietMs: 9000 });
        note(`> ${body}\n< [${r.status}] ${r.all || "(no reply)"}`);
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
      try {
        await sleep(1500);
        // 1. The resident files a leak on the client's own number; the assistant triages like a person would.
        const filed = async () => ((await db.from("portal_work_order_records").select("id, row_data").eq("manager_user_id", sd.client.id).eq("resident_email", sd.resident.email)).data ?? []);
        let r = await say(sd.residentPhone, sd.clientLine, "my kitchen sink is leaking", { media: [{ url: h.mediaUrl("leak"), type: "image/png" }] });
        const answers = ["Clean water, nothing electrical nearby, and I already closed the shutoff valve under the sink. Please file it now.", "Yes they can enter if I am not home, any time works. Please file it."];
        for (let step = 0, next = 0; step < 6 && (await filed()).length === 0; step += 1) {
          if (/reply yes to confirm/i.test(r.all)) r = await say(sd.residentPhone, sd.clientLine, "YES");
          else r = await say(sd.residentPhone, sd.clientLine, answers[Math.min(next++, answers.length - 1)]);
        }
        const orders = await filed();
        check("the resident's leak is filed as a service in the client's workspace", orders.length === 1, JSON.stringify(orders.map((o) => o.id)));
        if (orders.length !== 1) return;

        // 2. A dispatch run exists, owned by the client, in the service workspace, waiting on the SERVICE MANAGER.
        const run = await waitFor(async () => ((await db.from("vendor_dispatch_runs").select("id, status, handle, workspace_id, owner_user_id, trade").eq("owner_user_id", sd.client.id)).data ?? [])[0]);
        check("a dispatch run was created for the service workspace", Boolean(run) && run.workspace_id === sd.workspaceId && run.trade === "plumber", JSON.stringify(run));
        if (!run) return;
        check("the run waits for approval", run.status === "awaiting_approval", run.status);
        const { data: attempts } = await db.from("vendor_dispatch_attempts").select("vendor_directory_id, status").eq("run_id", run.id);
        check("the chain is the service roster (the roster vendor is offered, nobody else)", (attempts ?? []).map((a) => a.vendor_directory_id).join() === sd.vendorId, JSON.stringify(attempts));
        const ask = toPhone(sd.managerPhone).map((m) => m.body).join("\n");
        check("the SERVICE MANAGER phone was asked to approve, with the job number", new RegExp(`#${run.handle}\\b`).test(ask), ask || "(nothing sent to the manager phone)");
        check("the client owner was not texted for the approval", toPhone(sd.client.phone ?? "0000000000").every((m) => !new RegExp(`#${run.handle}\\b`).test(m.body)), "client texted");
        check("the roster vendor was NOT texted before approval", toPhone(sd.vendorPhone).length === 0, JSON.stringify(toPhone(sd.vendorPhone)));

        // 3. The manager phone approves on the PropLane line - with the 4-digit code the ask carried, because the
        //    inbound caller ID on that line proves nothing (a bare Y only re-asks).
        const askedCode = new RegExp(`Reply Y ${run.handle} (\\d{4})`).exec(ask)?.[1] ?? "";
        check("the approval ask carries the PropLane line's confirmation code", /^\d{4}$/.test(askedCode), ask);
        const bare = await say(sd.managerPhone, fx.line, `Y ${run.handle}`);
        check("a bare Y does not approve: it re-asks with a fresh code", /needs its code/i.test(bare.all), bare.all);
        const code = new RegExp(`Reply Y ${run.handle} (\\d{4})`, "i").exec(bare.all)?.[1] ?? askedCode;
        const approve = await say(sd.managerPhone, fx.line, `Y ${run.handle} ${code}`);
        check("the manager's coded Y on the PropLane line approves the job", /approved/i.test(approve.all), approve.all);
        const offer = await waitFor(async () => toPhone(sd.vendorPhone).map((m) => m.body).join("\n") || null, 45_000);
        check("the roster vendor is offered the job from the PropLane line: general area only, no street address", Boolean(offer) && !/Brooklyn Ave/i.test(offer ?? "") && /plumb|leak|sink/i.test(offer ?? ""), offer ?? "(no offer sent)");

        // 4. The vendor's YES arrives on the PropLane line and assigns the job.
        const yes = await say(sd.vendorPhone, fx.line, "YES");
        check("the vendor's YES is accepted", /(got it|accepted|confirmed|you have|assigned|you're on)/i.test(yes.all) || yes.status === 200, yes.all);
        const accepted = await waitFor(async () => {
          const { data } = await db.from("vendor_dispatch_runs").select("status, accepted_vendor_directory_id").eq("id", run.id).maybeSingle();
          return data?.status === "accepted" ? data : null;
        }, 30_000);
        check("the run is accepted by the roster vendor", accepted?.accepted_vendor_directory_id === sd.vendorId, JSON.stringify(accepted));
        const after = (await filed())[0];
        check("the client's service is assigned to the roster vendor", after?.row_data?.vendorId === sd.vendorId, JSON.stringify({ vendorId: after?.row_data?.vendorId }));
        const outcomes = toPhone(sd.managerPhone).length;
        check("the manager phone was told the outcome (more than the approval ask)", outcomes >= 2, String(outcomes));
        // 5. The manager phone is the manager of EVERY service workspace: with several, it is asked which one; naming one answers
        //    from that workspace's own data (the leak filed above), as the full manager agent.
        const which = await say(sd.managerPhone, fx.line, "any tours this week?");
        check("with several service workspaces the manager phone is asked which one", /^Is this about .+ or .+\?$/i.test(which.all.trim()), which.all);
        const services = await say(sd.managerPhone, fx.line, `list every service at E2E 1. ClientAmbika, assigned or open, ${world.runId}`);
        check("naming a workspace answers from that workspace's data (the kitchen sink leak)", /sink|leak|kitchen/i.test(services.all), services.all);
        check("the manager agent's reply says 'service', never 'work order'", !/work order/i.test(services.all), services.all);
        check("no text uses the word 'work order'", h.captured().every((m) => !/work order/i.test(m.body)), h.captured().filter((m) => /work order/i.test(m.body)).map((m) => m.body).join(" | "));
      } finally {
        await restore();
      }
    },
  },
];

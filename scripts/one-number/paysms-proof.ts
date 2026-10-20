/**
 * Dev proof for the pay-by-text work (#4 codes are actually texted, #8 rent reminders carry a pay link,
 * #10 the pay link's destination states). Real route, real outbox + dispatcher + consent + credit code, the
 * DEV database (emstjswhotsnyksqhqyf), the capture transport (nothing is sent), throwaway fixtures.
 *
 *   node --conditions react-server --import tsx scripts/one-number/paysms-proof.ts [--port 3012]
 *
 * It takes the dev e2e lock (`$HOME/.cockpit/slots-1018/e2e.lock`, retry 60 s, branch + pid), waits for the
 * health gate (profiles?select=id&limit=1 under 2 s), flips the line to `shared` for ITS workspace only,
 * starts `next dev --webpack`, and restores the config and removes its fixtures at the end.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireE2eLock, waitHealthy } from "./e2e/health.mjs";
import { CRON_SECRET, FAKE_ACCOUNT_SID, FAKE_AUTH_TOKEN, Harness, createDb, hex, loadDevEnv } from "./e2e/core.mjs";
import { restoreBaseline } from "./e2e/baseline.mjs";
import { cleanup } from "./e2e/cleanup.mjs";
import { World } from "./e2e/fixtures.mjs";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 3012);
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: unknown, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: ok ? "" : detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail.replace(/\n/g, "\n        ")}`}`);
}
const keyOf = (phone: string) => phone.replace(/\D/g, "").slice(-10);

async function main(): Promise<number> {
  const { env, resolved } = loadDevEnv();
  const db = createDb(resolved);
  const release = await acquireE2eLock(console.log, { branch: "on/paysms" });
  const runId = hex(6);
  const dir = mkdtempSync(join(tmpdir(), `paysms-proof-${runId}-`));
  const captureFile = join(dir, "captured-sms.jsonl");
  writeFileSync(captureFile, "");
  const world = new World(db, runId);
  let snapshot: Record<string, unknown> | null = null;
  const h = new Harness({ env, resolved, port, captureFile });
  const ledger = () => ({ userIds: world.userIds, workspaceIds: world.workspaceIds, houseIds: world.houseIds, phones: world.phones });
  try {
    await waitHealthy(resolved, env, console.log);
    await restoreBaseline(db, console.log);
    await world.reservePhones(20);

    // The in-process half (reminders) runs the same code the server does, with the same environment and capture file.
    Object.assign(process.env, env, {
      NODE_ENV: "development",
      SMS_E2E_CAPTURE_FILE: captureFile,
      TWILIO_ACCOUNT_SID: FAKE_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN,
      TWILIO_API_KEY_SID: "",
      TWILIO_API_KEY_SECRET: "",
      CRON_SECRET,
    });
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;

    const managerPhone = world.phone();
    const manager = await world.createUser({ label: "mgr", role: "manager", phone: managerPhone, fullName: "Morgan Manager" });
    const workspaceId = await world.createWorkspace({ ownerId: manager.id, name: `E2E Paysms Homes ${runId}` });
    const house = await world.createHouse({ ownerId: manager.id, workspaceId, name: `E2E Paysms House ${runId}`, street: "5400 Ballard Ave NW" });
    const residentPhone = world.phone();
    const resident = await world.createResident({ ownerId: manager.id, house, label: "res", phone: residentPhone, fullName: "Riley Resident", overdue: false });
    const strangerPhone = world.phone();
    const rentChargeId = resident.charges[0]!.id;

    const { data: cfg } = await db.from("sms_runtime_config").select("line_mode, shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids, pilot_manager_user_ids").eq("singleton", true).maybeSingle();
    if (!cfg) throw new Error("no sms_runtime_config");
    snapshot = { ...cfg };
    const { error: flipError } = await db.from("sms_runtime_config").update({
      line_mode: "shared",
      shared_pilot_workspace_ids: [workspaceId],
      pilot_manager_user_ids: [...new Set([...(cfg.pilot_manager_user_ids ?? []), manager.id])],
    }).eq("singleton", true);
    if (flipError) throw new Error(`cannot switch the line: ${flipError.message}`);
    console.log(`proof: run ${runId}; line_mode=shared pilot=[${workspaceId}] capture ${captureFile}`);

    await h.startServer();
    console.log(`proof: dev server ready on ${h.base}`);
    const captured = (from = 0) => h.captured(from);
    const toResident = (from = 0) => captured(from).filter((m: { to: string }) => keyOf(m.to) === keyOf(residentPhone));

    // ---- #4: a rent link's code is actually texted ---------------------------------------------------------
    console.log("\n== #4  rent link: GET /l/<token>, POST /api/l/<token>/code");
    await waitHealthy(resolved, env, console.log);
    const mintDirect = async (targetId: string, phone: string) => {
      const token = randomBytes(32).toString("base64url");
      const { error } = await db.from("phone_bound_links").insert({
        token_hash: createHash("sha256").update(token, "utf8").digest("hex"), phone_key: keyOf(phone), workspace_id: workspaceId, purpose: "rent",
        target_type: "charge", target_id: targetId, requires_otp: true, expires_at: new Date(Date.now() + 10 * 86400000).toISOString(), created_by: manager.id,
      });
      if (error) throw new Error(`mint: ${error.message}`);
      return token;
    };
    const token = await mintDirect(rentChargeId, residentPhone);
    const page = await fetch(`${h.base}/l/${token}`, { redirect: "manual" });
    const pageHtml = await page.text();
    check("GET /l/<token> shows the code gate, not the charge", page.status === 200 && /code/i.test(pageHtml) && !/October rent/.test(pageHtml), `status ${page.status}`);

    const mark = h.captureMark();
    const send = await fetch(`${h.base}/api/l/${token}/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send" }) });
    const sendBody = await send.text();
    check("POST /api/l/<token>/code {send} answers 200 (the code was accepted for sending)", send.status === 200, `status ${send.status} ${sendBody}`);
    const codeTexts = toResident(mark);
    check("the code text reached the capture transport, to the link's own phone", codeTexts.length === 1 && /\b\d{6}\b is your PropLane code/.test(codeTexts[0]?.body ?? ""), JSON.stringify(codeTexts));
    const code = /\b(\d{6})\b/.exec(codeTexts[0]?.body ?? "")?.[1] ?? "";
    const { data: codeOutbox } = await db.from("sms_outbox").select("send_class, purpose, status, blocked_reason").eq("recipient_phone", `+1${keyOf(residentPhone)}`).eq("purpose", "phone_link_code").order("created_at", { ascending: false }).limit(1);
    check("its outbox row is control class, purpose phone_link_code, submitted (not blocked)", codeOutbox?.[0]?.send_class === "control" && ["submitted", "sent", "delivered"].includes(String(codeOutbox?.[0]?.status)), JSON.stringify(codeOutbox));

    const verify = await fetch(`${h.base}/api/l/${token}/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", code }) });
    const cookie = (verify.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    check("the right code opens a session cookie", verify.status === 200 && /^pbl_/.test(cookie), `status ${verify.status} cookie=${cookie}`);
    const opened = await (await fetch(`${h.base}/l/${token}`, { headers: { cookie } })).text();
    check("then the page shows the charge to pay", /October rent/.test(opened) && /850|900|1,000|\$/.test(opened), opened.slice(0, 200));

    // ---- #10: destination states --------------------------------------------------------------------------
    console.log("\n== #10  pay-link states");
    const view = async () => (await (await fetch(`${h.base}/l/${token}`, { headers: { cookie } })).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const setCharge = async (patch: Record<string, unknown>, status: string) => {
      const { data } = await db.from("portal_household_charge_records").select("row_data").eq("id", rentChargeId).maybeSingle();
      await db.from("portal_household_charge_records").update({ status, row_data: { ...(data?.row_data as object), ...patch, status } }).eq("id", rentChargeId);
    };
    await setCharge({}, "processing");
    check("a bank debit still clearing reads 'Payment processing' and the link stays usable", /Payment processing/.test(await view()), await view());
    const { data: stillOpen } = await db.from("phone_bound_links").select("used_at, revoked_at").eq("token_hash", createHash("sha256").update(token).digest("hex")).maybeSingle();
    check("...and is not marked used", stillOpen && !stillOpen.used_at && !stillOpen.revoked_at, JSON.stringify(stillOpen));
    await setCharge({ balanceLabel: "$300.00", amountLabel: "$900.00" }, "partially_paid");
    const partial = await view();
    check("a part-paid charge shows the remaining balance to pay, not 'expired'", /\$300\.00/.test(partial) && !/expired/i.test(partial), partial);
    const origPhone = `+1${keyOf(residentPhone)}`;
    await db.from("profiles").update({ phone: `+1${keyOf(strangerPhone)}` }).eq("id", resident.id);
    const moved = await view();
    check("a changed verified phone refuses the old link: 'Text us for a new link'", /Text us for a new link/.test(moved), moved);
    await db.from("profiles").update({ phone: origPhone }).eq("id", resident.id);
    await setCharge({ balanceLabel: "$0.00" }, "paid");
    check("a paid charge reads 'Payment received'", /Payment received/.test(await view()), await view());

    // ---- STOP is never bypassed ---------------------------------------------------------------------------
    console.log("\n== #4  STOP still blocks a code");
    await setCharge({ balanceLabel: "$900.00" }, "pending");
    const stopToken = await mintDirect(rentChargeId, residentPhone);
    await db.from("profiles").update({ sms_opt_out_at: new Date().toISOString() }).eq("id", resident.id);
    const stopMark = h.captureMark();
    const stopped = await fetch(`${h.base}/api/l/${stopToken}/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send" }) });
    check("a number that texted STOP gets no code", stopped.status !== 200 && toResident(stopMark).length === 0, `status ${stopped.status} texts ${JSON.stringify(toResident(stopMark))}`);
    await db.from("profiles").update({ sms_opt_out_at: null }).eq("id", resident.id);

    // ---- #8: reminders carry a real pay link ---------------------------------------------------------------
    console.log("\n== #8  reminders");
    await setCharge({ balanceLabel: "$900.00" }, "pending");
    const payLinkOf = (body: string) => /(https?:\/\/\S+\/l\/[A-Za-z0-9_-]{40,})/.exec(body)?.[1] ?? "";
    const lastLine = (body: string) => body.split("\n").at(-1) ?? "";

    const { sendWeeklyRentReminders } = await import("../../src/lib/sms/weekly-rent-reminder.server");
    const weeklyMark = h.captureMark();
    const weekly = await sendWeeklyRentReminders(db as never, { now: new Date(), managerUserId: manager.id });
    const weeklyText = toResident(weeklyMark)[0];
    check("weekly reminder: sent once", weekly.sent === 1, JSON.stringify(weekly));
    check("weekly reminder carries a /l/<token> pay link on its own line (the last line)", weeklyText && lastLine(weeklyText.body) === payLinkOf(weeklyText.body) && payLinkOf(weeklyText.body) !== "", weeklyText?.body ?? "(no text)");
    check("...and it is plain GSM-7 within two segments", weeklyText && /^[\x20-\x7E\n]*$/.test(weeklyText.body) && weeklyText.body.length <= 306, weeklyText?.body ?? "");
    const weeklyLink = payLinkOf(weeklyText?.body ?? "");
    if (weeklyLink) {
      const opened2 = await fetch(`${h.base}${new URL(weeklyLink).pathname}`, { redirect: "manual" });
      check("...and the link from the reminder opens its code gate", opened2.status === 200 && /code/i.test(await opened2.text()), `status ${opened2.status}`);
    }
    const weeklyAgain = await sendWeeklyRentReminders(db as never, { now: new Date(), managerUserId: manager.id });
    check("weekly reminder: a second run the same week sends nothing", weeklyAgain.sent === 0 && weeklyAgain.skippedAlreadySent === 1, JSON.stringify(weeklyAgain));

    const { deliverPaymentReminder } = await import("../../src/lib/payment-reminder-delivery");
    const { data: chargeRow } = await db.from("portal_household_charge_records").select("row_data").eq("id", rentChargeId).maybeSingle();
    const dailyMark = h.captureMark();
    const daily = await deliverPaymentReminder({
      db: db as never,
      charge: chargeRow!.row_data as never,
      managerId: manager.id,
      dedupId: `payment_reminder_paysms_${runId}`,
      managerName: "Morgan Manager",
      apiKey: "",
      from: "PropLane <test@proplane-e2e.test>",
      subject: "Payment due in 3 days: October rent",
      text: "Hi Riley,\n\nThis is a reminder that your October rent payment is due in 3 days (Nov 1).\n\nHow to sign in to PropLane:\n• Open: https://proplane.ai/login\n• Use the same email we have on file.",
      html: "<p>x</p>",
      slotLabel: "3_days_before",
      managerDeliverViaSms: true,
      managerDeliverViaEmail: false,
    });
    const dailyText = toResident(dailyMark)[0];
    check("daily reminder: delivered", daily.sent === true, JSON.stringify(daily));
    check("daily reminder text: the sign-in block is gone, a /l/<token> link is the last line", dailyText && lastLine(dailyText.body) === payLinkOf(dailyText.body) && payLinkOf(dailyText.body) !== "" && !/sign in to propLane/i.test(dailyText.body), dailyText?.body ?? "(no text)");
    check("...and it left from the PropLane line, not an owner number", dailyText && dailyText.from === cfg.shared_number_e164, JSON.stringify(dailyText?.from));

    const { sendRentDueDayLinks } = await import("../../src/lib/automations/rent-due-links.server");
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await setCharge({ rentMonth: todayKey.slice(0, 7), dueDay: today.getDate() }, "pending");
    const dueMark = h.captureMark();
    const due = await sendRentDueDayLinks(db as never, {
      house: { ownerUserId: manager.id, workspaceId, propertyId: house.id, propertyLabel: house.name } as never,
      roster: [{ leaseId: "l", ownerUserId: manager.id, workspaceId, propertyId: house.id, propertyLabel: house.name, roomLabel: null, residentName: "Riley Resident", firstName: "Riley", residentUserId: resident.id, residentEmail: resident.email, phoneKey: keyOf(residentPhone), signedKey: null, moveIn: null, moveOut: null }],
      todayKey,
    });
    const dueText = toResident(dueMark)[0];
    check("rent-due-day: the resident gets their own pay link (the group text promised it)", due.sent === 1 && dueText && payLinkOf(dueText.body) !== "", `${JSON.stringify(due)} ${dueText?.body ?? "(no text)"}`);

    console.log("\n== captured texts to the resident");
    for (const m of toResident()) console.log(`  [${m.at}] from ${m.from}\n${String(m.body).split("\n").map((l: string) => `      | ${l}`).join("\n")}`);
  } catch (error) {
    console.error("proof: harness error:", error instanceof Error ? error.stack : error);
    check("proof ran to the end", false, error instanceof Error ? error.message : String(error));
  } finally {
    h.stopServer();
    try {
      if (snapshot) await db.from("sms_runtime_config").update({ line_mode: snapshot.line_mode, shared_pilot_workspace_ids: snapshot.shared_pilot_workspace_ids ?? [], pilot_manager_user_ids: snapshot.pilot_manager_user_ids ?? [] }).eq("singleton", true);
      await db.from("phone_bound_links").delete().in("workspace_id", world.workspaceIds);
      await cleanup(db, ledger(), console.log);
      await restoreBaseline(db, console.log);
    } catch (error) {
      console.error("proof: cleanup problem:", error instanceof Error ? error.message : error);
    }
    release();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nproof: ${results.length - failed.length} passed, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 2; });

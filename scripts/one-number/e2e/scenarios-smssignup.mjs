/**
 * Sign up by text on the PropLane line (per_workspace, what production runs), through the REAL webhook: a stranger texts
 * "Hey I want to sign up as a manager", answers one question per text, and gets an account only after texting back the code
 * we texted it. A vendor does the same. Nothing is sent: the transport capture records every reply (the code is read from it).
 *
 * Fixtures: the svcline service owner / line (the real platform service owner row and line mode are restored after). The accounts
 * the conversations create are registered with the harness (users, workspaces, phones) so cleanup removes them.
 */
import { createClient } from "@supabase/supabase-js";
import { sleep } from "./core.mjs";
import { ensureServiceLine, enterPerWorkspace } from "./scenarios-svcline.mjs";

const codeOf = (text) => /code: (\d{6})/.exec(text ?? "")?.[1] ?? "";

export const SMSSIGNUP_SCENARIOS = [
  {
    id: "sms-signup",
    title: "PropLane line: sign up by text as a manager and as a vendor, the code echo is the proof, no second account for the same phone",
    async setup(h, world) {
      h.fx ??= {};
      h.fx.svcReady = ensureServiceLine(h, world);
      await h.fx.svcReady;
    },
    async run(ctx) {
      const { h, world, db, check, note } = ctx;
      const fx = await h.fx.svcReady;
      const restorePerWorkspace = await enterPerWorkspace(db, fx);
      const { data: runtime } = await db.from("sms_runtime_config").select("pilot_manager_user_ids").eq("singleton", true).maybeSingle();
      const pilotBefore = runtime?.pilot_manager_user_ids ?? [];
      await db.from("sms_runtime_config").update({ pilot_manager_user_ids: [...new Set([...pilotBefore, fx.owner.id])] }).eq("singleton", true);
      const restore = async () => {
        await db.from("sms_runtime_config").update({ pilot_manager_user_ids: pilotBefore }).eq("singleton", true);
        await restorePerWorkspace();
      };
      const say = async (from, body) => {
        const r = await h.text({ from, to: fx.line, body, quietMs: 9000 });
        let all = r.all;
        let queued = "";
        if (!all) {
          const { data } = await db.from("sms_outbox").select("status, body, blocked_reason").eq("recipient_phone", from).order("created_at", { ascending: false }).limit(1);
          if (data?.[0]) { all = String(data[0].body ?? ""); queued = ` [outbox ${data[0].status}${data[0].blocked_reason ? `: ${data[0].blocked_reason}` : ""}]`; }
        }
        note(`> ${body}\n< [${r.status}]${queued} ${all || "(no reply)"}`);
        return { ...r, all };
      };
      const profileOf = async (phone) => (await db.from("profiles").select("id, role, phone, phone_verified_at, email").eq("phone", phone)).data ?? [];
      // Register what the conversation created so the harness cleanup removes it.
      const adopt = async (phone) => {
        const [p] = await profileOf(phone);
        if (!p) return null;
        if (!world.userIds.includes(p.id)) world.userIds.push(p.id);
        const { data: ws } = await db.from("portal_workspaces").select("id").eq("owner_user_id", p.id);
        for (const w of ws ?? []) if (!world.workspaceIds.includes(w.id)) world.workspaceIds.push(w.id);
        return p;
      };
      const anon = createClient(h.env.NEXT_PUBLIC_SUPABASE_URL, h.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

      try {
        await sleep(1500);

        // ---- manager ----
        const mgr = world.phone();
        const mgrKey = mgr.replace(/\D/g, "").slice(-10);
        const first = await say(mgr, "Hey I want to sign up as a manager");
        check("manager: the sign-up ask is answered with the manager flow, never the /demo link", /property manager account/.test(first.all) && /full name/i.test(first.all) && !/\/demo/.test(first.all), first.all);
        check("manager: the first reply also carries the web sign-up link", /\/start\//.test(first.all), first.all);
        await say(mgr, "Jane Test");
        await say(mgr, "Test Rentals");
        await say(mgr, "12");
        const toCode = await say(mgr, "jane.test@example.com");
        const code = codeOf(toCode.all);
        check("manager: the last question texts a 6-digit code", /^\d{6}$/.test(code), toCode.all);
        check("manager: no account exists before the code comes back", (await profileOf(mgr)).length === 0);
        const wrong = await say(mgr, code === "000000" ? "111111" : "000000");
        check("manager: a wrong code is refused", /does not match/.test(wrong.all), wrong.all);
        check("manager: still no account after a wrong code", (await profileOf(mgr)).length === 0);
        const done = await say(mgr, code);
        check("manager: the right code ends in 'You're set' with a one-tap link", /^You're set, Jane\. Your PropLane account is ready\. Manage everything right here by text, or open your portal: https?:\/\/\S+\/auth\/confirm\?token_hash=\S+&type=magiclink/.test(done.all), done.all);

        const account = await adopt(mgr);
        check("manager: an account exists with the proven phone, verified", Boolean(account?.phone_verified_at) && account.phone === mgr, JSON.stringify(account));
        if (account) {
          const roles = (await db.from("profile_roles").select("role").eq("user_id", account.id)).data ?? [];
          check("manager: the manager role only (the website's account, not a resident too)", roles.length === 1 && roles[0].role === "manager", JSON.stringify(roles));
          const ws = (await db.from("portal_workspaces").select("name, is_default").eq("owner_user_id", account.id)).data ?? [];
          check("manager: the default workspace carries the business name", ws.some((w) => w.is_default && w.name === "Test Rentals"), JSON.stringify(ws));
          const purchase = (await db.from("manager_purchases").select("tier, billing").eq("user_id", account.id)).data ?? [];
          check("manager: on the Free plan, no paid trial", purchase.length === 1 && purchase[0].tier === "free", JSON.stringify(purchase));
          const { data: auth } = await db.auth.admin.getUserById(account.id);
          check("manager: the login is a placeholder; the typed email is an unverified claim in metadata only", /@phone\.proplane\.invalid$/.test(auth.user?.email ?? "") && auth.user?.user_metadata?.unverified_email === "jane.test@example.com" && account.email !== "jane.test@example.com", JSON.stringify({ email: auth.user?.email, meta: auth.user?.user_metadata, profileEmail: account.email }));
          const challenges = (await db.from("phone_otp_challenges").select("purpose, verified_at, consumed_at").eq("phone_key", mgrKey).eq("purpose", "sms_signup")).data ?? [];
          check("manager: the proof is on record (sms_signup, verified, spent)", challenges.length >= 1 && challenges.some((c) => c.verified_at && c.consumed_at), JSON.stringify(challenges));
          const session = (await db.from("sms_signup_sessions").select("step, user_id, answers").eq("phone_key", mgrKey)).data ?? [];
          check("manager: the session is done, linked to the account, typed answers dropped", session[0]?.step === "done" && session[0]?.user_id === account.id && !JSON.stringify(session[0].answers).includes("jane.test"), JSON.stringify(session));

          // The link: token_hash, single use, signs in as that account.
          const tokenHash = /token_hash=([^&\s]+)/.exec(done.all)?.[1];
          const ok1 = tokenHash ? await anon.auth.verifyOtp({ token_hash: decodeURIComponent(tokenHash), type: "magiclink" }) : { error: { message: "no token" } };
          check("link: the token_hash signs in as the new account", !ok1.error && ok1.data?.user?.id === account.id, JSON.stringify(ok1.error ?? ok1.data?.user?.id));
          const ok2 = tokenHash ? await anon.auth.verifyOtp({ token_hash: decodeURIComponent(tokenHash), type: "magiclink" }) : { error: null };
          check("link: single use (a second use is refused)", Boolean(ok2.error), "second use worked");
        }

        // ---- the same phone again: no second account ----
        const again = await say(mgr, "sign me up as a manager");
        check("duplicate: told the number already has an account, with a sign-in link", /already has a PropLane account/.test(again.all) && /auth\/confirm\?token_hash=/.test(again.all), again.all);
        check("duplicate: still exactly one account for the phone", (await profileOf(mgr)).length === 1);
        const sessions = (await db.from("sms_signup_sessions").select("step").eq("phone_key", mgrKey)).data ?? [];
        check("duplicate: no new conversation was opened", sessions.length === 1 && sessions[0].step === "done", JSON.stringify(sessions));

        // ---- vendor ----
        const ven = world.phone();
        const venFirst = await say(ven, "I want to sign up as a vendor");
        check("vendor: answered with the vendor flow and the web sign-up link", /vendor account/.test(venFirst.all) && /\/start\//.test(venFirst.all), venFirst.all);
        const trade = await say(ven, "Sam Vendor");
        check("vendor: asked the trade", /kind of work/.test(trade.all), trade.all);
        await say(ven, "plumbing");
        await say(ven, "Ballard 98107");
        const venCodeText = await say(ven, "SKIP");
        const venCode = codeOf(venCodeText.all);
        check("vendor: the last question texts a code", /^\d{6}$/.test(venCode), venCodeText.all);
        check("vendor: no account before the code", (await profileOf(ven)).length === 0);
        const venDone = await say(ven, venCode);
        check("vendor: 'You're set' with a one-tap link", /^You're set, Sam\./.test(venDone.all) && /auth\/confirm\?token_hash=/.test(venDone.all), venDone.all);
        const vendor = await adopt(ven);
        check("vendor: an account with a verified phone", Boolean(vendor?.phone_verified_at), JSON.stringify(vendor));
        if (vendor) {
          const roles = (await db.from("profile_roles").select("role").eq("user_id", vendor.id)).data ?? [];
          check("vendor: the vendor role only, profile primary role vendor", roles.length === 1 && roles[0].role === "vendor" && vendor.role === "vendor", JSON.stringify({ roles, role: vendor.role }));
          const biz = (await db.from("vendor_business_profiles").select("trades, service_area_zips").eq("user_id", vendor.id)).data ?? [];
          check("vendor: the business record carries the trade and zip", biz[0]?.trades?.includes("Plumbing") && biz[0]?.service_area_zips?.includes("98107"), JSON.stringify(biz));
        }
        const leads = (await db.from("sms_vendor_leads").select("id").eq("phone_key", ven.replace(/\D/g, "").slice(-10))).data ?? [];
        void leads;

        // ---- not a sign-up: untouched ----
        const searcher = world.phone();
        const reply = await say(searcher, "Is there any house available near the U District?");
        check("a renter's question is not turned into a sign-up", !/full name|sign up|account/i.test(reply.all), reply.all);
        check("a renter's question opened no sign-up session", ((await db.from("sms_signup_sessions").select("phone_key").eq("phone_key", searcher.replace(/\D/g, "").slice(-10))).data ?? []).length === 0);
      } finally {
        await restore();
      }
    },
  },
];

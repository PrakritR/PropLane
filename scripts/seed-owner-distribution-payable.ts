#!/usr/bin/env npx tsx
/**
 * One-shot: create the captain's flat monthly owner payment as a RECURRING PAYABLE in his workspace
 * (a payee + a monthly schedule that generates one Due entry per month). It records and reminds; it moves
 * no money. DRY-RUN by default: nothing is written until --apply.
 *
 *   # what it would do (dev/test, default)
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/seed-owner-distribution-payable.ts \
 *     --manager=<captain user uuid>
 *
 *   # write it to the dev/test database
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/seed-owner-distribution-payable.ts \
 *     --manager=<uuid> --apply
 *
 * Options (defaults in brackets): --payee-name ["Ambika"] --amount <dollars> [8000] --day <1-28> [1]
 *   --start <YYYY-MM-DD> [first of next month] --category <chart code> [mortgage] --label [...]
 *   --method <p2p_transfer|ach|card|check|cash|other> [p2p_transfer]
 *
 * Idempotent: a payable with the same label already on the account is left alone. The live project is
 * refused unless --allow-production is passed AND the owner has authorized it (AGENTS.md hard stops); the
 * locked live listings are untouched (the schedule carries no property).
 */
import { createClient } from "@supabase/supabase-js";
import { createRecurringPayable, generateDueRecurringEntries } from "../src/lib/finance/recurring-payables.server";
import { isPaymentMethod } from "../src/lib/finance/payment-fields";

const PRODUCTION_REF = "qahnczmilgptcedaqype";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const managerUserId = arg("manager");
  if (!managerUserId) {
    console.error("--manager=<user uuid> is required: this seeds one workspace owner only.");
    process.exit(1);
  }
  if (url.includes(PRODUCTION_REF) && !process.argv.includes("--allow-production")) {
    console.error("This is the live project: pass --allow-production (and have the owner's explicit authorization).");
    process.exit(1);
  }
  const amountDollars = Number(arg("amount") ?? "8000");
  const day = Number(arg("day") ?? "1");
  const method = arg("method") ?? "p2p_transfer";
  if (!(amountDollars > 0) || !Number.isInteger(day) || day < 1 || day > 28 || !isPaymentMethod(method)) {
    console.error("Invalid --amount, --day (1-28) or --method.");
    process.exit(1);
  }
  const start = arg("start") ?? firstOfNextMonth().slice(0, 8) + String(day).padStart(2, "0");
  const payeeName = arg("payee-name") ?? "Ambika";
  const label = arg("label") ?? `Owner payment - ${payeeName}`;
  const plan = {
    target: url.replace(/^https:\/\//, "").split(".")[0],
    managerUserId,
    mode: apply ? "APPLY" : "DRY-RUN",
    payee: { name: payeeName, payeeType: "owner" },
    payable: { label, amountCents: Math.round(amountDollars * 100), frequency: "monthly", nextDate: start, categoryCode: arg("category") ?? "mortgage", paymentMethod: method },
  };

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: existing } = await db
    .from("manager_recurring_payables").select("id, next_date, status").eq("manager_user_id", managerUserId).eq("label", label).maybeSingle();
  if (existing) {
    console.log(JSON.stringify({ ...plan, result: "already exists, nothing to do", existing }, null, 2));
    return;
  }
  if (!apply) {
    console.log(JSON.stringify({ ...plan, result: "dry run: nothing written (pass --apply)" }, null, 2));
    return;
  }

  let payeeId: string | null = null;
  const { data: payee } = await db
    .from("manager_payees").select("id").eq("manager_user_id", managerUserId).eq("name", payeeName).is("archived_at", null).maybeSingle();
  if (payee?.id) payeeId = String(payee.id);
  else {
    const { data: created, error } = await db
      .from("manager_payees")
      .insert({ manager_user_id: managerUserId, kind: "other", payee_type: "owner", name: payeeName, notes: "Flat monthly owner payment (covers mortgages, insurance, property tax).", updated_at: new Date().toISOString() })
      .select("id").single();
    if (error || !created?.id) { console.error(error?.message ?? "Could not create the payee."); process.exit(1); }
    payeeId = String(created.id);
  }
  const result = await createRecurringPayable(
    db, managerUserId,
    { ...plan.payable, label, payeeId, memo: "Flat monthly owner payment (mortgages, insurance, property tax)" },
    { propertyIds: null, includeUntagged: true },
  );
  if (!result.ok) { console.error(result.error); process.exit(1); }
  const generated = await generateDueRecurringEntries(db, new Date().toISOString().slice(0, 10), { managerUserId });
  console.log(JSON.stringify({ ...plan, result: "created", payableId: result.value.id, generated }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

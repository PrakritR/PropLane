/**
 * Dev/test fixture for the SMS conversation consolidation.
 *
 * The unit suite proves the append protocol against an in-memory fake. This
 * proves it against a real PostgREST: the insert-then-compare-and-swap loop in
 * `upsertManagerInboxNotice` depends on `ignoreDuplicates` and on `updated_at`
 * equality actually rejecting a stale writer, and a fake cannot show that.
 *
 * Writes rows. Dev/test project only, enforced below.
 *
 *   node --env-file=.env.test --conditions=react-server --import tsx \
 *     scripts/qa-sms-isolation.ts
 *
 * Expects: one row, three messages.
 */
import { createClient } from "@supabase/supabase-js";
import { formatInboxStamp } from "../src/lib/portal-inbox-storage";
import { upsertManagerInboxNotice } from "../src/lib/sms-inbox-notice.server";

const DEV_TEST_HOST = "emstjswhotsnyksqhqyf.supabase.co";
const QA_PHONE = "+12025550188";
const LEGACY_PHONE = "+12025550189";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (new URL(url).hostname !== DEV_TEST_HOST) throw new Error("Dev/test only");

const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** Rows a legacy producer wrote before notices had a stable per-phone id. */
async function seedLegacyNotices(ownerUserId: string) {
  for (const [index, phone] of [LEGACY_PHONE, "(202) 555-0189"].entries()) {
    const id = `claw_lease_qa_isolation_legacy_${index}`;
    const at = new Date(Date.now() - (2 - index) * 60_000);
    const body = `Legacy QA text ${index + 1}`;
    const { error } = await db.from("portal_inbox_thread_records").upsert({
      id,
      owner_user_id: ownerUserId,
      scope: "axis_portal_inbox_manager_v1",
      thread_type: "claw_leasing_sms",
      participant_email: null,
      updated_at: at.toISOString(),
      row_data: {
        id,
        from: phone,
        email: "",
        folder: "inbox",
        subject: "Legacy QA consolidation",
        preview: body,
        body,
        time: formatInboxStamp(at),
        unread: true,
        scope: "axis_portal_inbox_manager_v1",
      },
    });
    if (error) throw error;
  }
}

async function main() {
  const { data: profile, error } = await db
    .from("profiles")
    .select("id")
    .eq("email", "manager@test.proplane.local")
    .single();
  if (error) throw error;

  const base = {
    managerUserId: profile.id,
    idPrefix: "claw_lease",
    threadType: "claw_leasing_sms",
    from: QA_PHONE,
    subject: "QA consolidation",
    preview: "QA consolidation",
    body: "First QA text",
    messageId: "qa-isolation-first",
  };

  // Concurrent, and one of them formats the same phone differently: both must
  // land as separate turns on a single row.
  await Promise.all([
    upsertManagerInboxNotice(db, base),
    upsertManagerInboxNotice(db, {
      ...base,
      from: "(202) 555-0188",
      body: "Second QA text",
      messageId: "qa-isolation-second",
    }),
  ]);
  await upsertManagerInboxNotice(db, {
    ...base,
    body: "Third QA text",
    messageId: "qa-isolation-third",
  });

  await seedLegacyNotices(profile.id);

  const { data: rows, error: readError } = await db
    .from("portal_inbox_thread_records")
    .select("id,row_data")
    .eq("owner_user_id", profile.id)
    .eq("row_data->>smsNoticePhone", QA_PHONE);
  if (readError) throw readError;

  console.log(
    JSON.stringify({
      rows: rows.length,
      messages: 1 + (rows[0]?.row_data.messages?.length ?? 0),
      id: rows[0]?.id,
    }),
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

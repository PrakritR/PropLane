import path from "node:path";

const EMAIL = /^get-started-e2e-[0-9]+@example\.invalid$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_FREE_INTENT = /^axis_intent_[a-f0-9-]+$/i;

type Input = { userId: string; email: string; phone: string };
type Connection = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>; end(): Promise<void> };

async function connectDev(): Promise<Connection> {
  const ca = process.env.SUPABASE_DB_SSL_CA_FILE;
  if (!ca || !path.isAbsolute(ca)) throw new Error("Verified DEV database CA required.");
  const modulePath = "../../scripts/security/nonproduction-database.mjs";
  const { nonproductionDatabaseConfig, connectNonproductionDatabase } = await import(/* @vite-ignore */ modulePath);
  return connectNonproductionDatabase(nonproductionDatabaseConfig("emstjswhotsnyksqhqyf"));
}

export async function syntheticPhoneAvailableOnDev(phone: string): Promise<boolean> {
  if (!/^\+1\d{10}$/.test(phone)) throw new Error("Invalid synthetic phone candidate.");
  const db = await connectDev();
  try {
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("SET LOCAL statement_timeout='20s'");
    const auth = await db.query("select count(*)::int as count from auth.users where phone=$1", [phone]);
    const profiles = await db.query("select count(*)::int as count from public.profiles where phone=$1", [phone]);
    await db.query("ROLLBACK");
    return auth.rows[0]?.count === 0 && profiles.rows[0]?.count === 0;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

/**
 * Verify the real free manager-register result and set only this synthetic
 * profile's phone gate marker. This deliberately proves no SMS delivery.
 */
export async function verifySyntheticFreeManagerAndMarkPhone(input: Input): Promise<{ workspaceId: string }> {
  if (!UUID.test(input.userId) || !EMAIL.test(input.email) || !/^\+1\d{10}$/.test(input.phone)) {
    throw new Error("Invalid synthetic manager proof identity.");
  }
  const db = await connectDev();
  try {
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("SET LOCAL statement_timeout='20s'");
    const auth = await db.query(
      "select id::text,email,email_confirmed_at is not null as confirmed,raw_app_meta_data->>'proplane_email_onboarding' as onboarding_provenance from auth.users where id=$1",
      [input.userId],
    );
    if (auth.rows.length !== 1 || String(auth.rows[0]?.email).toLowerCase() !== input.email || auth.rows[0]?.confirmed !== true || auth.rows[0]?.onboarding_provenance !== "true") {
      throw new Error("Verified synthetic Auth subject did not match.");
    }
    const profile = await db.query(
      "select id::text,email,phone,phone_verified_at,role from public.profiles where id=$1",
      [input.userId],
    );
    if (profile.rows.length !== 1 || String(profile.rows[0]?.email).toLowerCase() !== input.email || profile.rows[0]?.phone !== input.phone || profile.rows[0]?.phone_verified_at != null) {
      throw new Error("Synthetic profile phone state did not match.");
    }
    const roles = await db.query("select role from public.profile_roles where user_id=$1 order by role", [input.userId]);
    if (JSON.stringify(roles.rows.map((row: { role: string }) => row.role)) !== JSON.stringify(["manager"])) {
      throw new Error("Synthetic account did not receive only the manager role.");
    }
    const purchases = await db.query(
      `select tier,billing,promo_code,stripe_customer_id,stripe_subscription_id,stripe_checkout_session_id,apple_original_transaction_id,user_id::text
       from public.manager_purchases where user_id=$1 order by paid_at desc nulls last limit 3`,
      [input.userId],
    );
    if (purchases.rows.length !== 1) throw new Error("Synthetic free purchase row count changed.");
    const purchase = purchases.rows[0]!;
    const internalCheckoutIntent = typeof purchase.stripe_checkout_session_id === "string" && INTERNAL_FREE_INTENT.test(purchase.stripe_checkout_session_id);
    if (purchase.tier !== "free" || purchase.billing !== "free" || purchase.promo_code != null || purchase.user_id !== input.userId ||
      [purchase.stripe_customer_id, purchase.stripe_subscription_id, purchase.apple_original_transaction_id]
        .some((value) => value != null && value !== "") ||
      (purchase.stripe_checkout_session_id != null && purchase.stripe_checkout_session_id !== "" && !internalCheckoutIntent)) {
      throw new Error("Manager-register did not produce an internally free, provider-unanchored purchase.");
    }
    const workspaces = await db.query(
      "select id::text,is_default,is_service,stripe_connect_account_id from public.portal_workspaces where owner_user_id=$1 order by id",
      [input.userId],
    );
    if (workspaces.rows.length !== 1 || workspaces.rows[0]?.is_default !== true || workspaces.rows[0]?.is_service !== false || workspaces.rows[0]?.stripe_connect_account_id != null) {
      throw new Error("Synthetic manager must own one default non-service workspace without a payment connection.");
    }
    const workspaceId = String(workspaces.rows[0]!.id);
    const properties = await db.query(
      "select count(*)::int as count from public.manager_property_records where manager_user_id=$1 or workspace_id=$2",
      [input.userId, workspaceId],
    );
    if (properties.rows[0]?.count !== 0) throw new Error("Synthetic workspace already has a property.");
    const connections = await db.query(
      "select count(*)::int as count from public.listing_channel_connections where manager_user_id=$1 or workspace_id=$2",
      [input.userId, workspaceId],
    );
    const posts = await db.query(
      "select count(*)::int as count from public.listing_channel_posts where manager_user_id=$1 or workspace_id=$2",
      [input.userId, workspaceId],
    );
    if (connections.rows[0]?.count !== 0 || posts.rows[0]?.count !== 0) throw new Error("Synthetic manager has listing-channel state.");
    const smsOutbox = await db.query("select count(*)::int as count from public.sms_outbox where manager_user_id=$1 or actor_user_id=$1", [input.userId]);
    const outboundMail = await db.query("select count(*)::int as count from public.portal_outbound_mail_records where lower(recipient_email)=lower($1)", [input.email]);
    if (smsOutbox.rows[0]?.count !== 0 || outboundMail.rows[0]?.count !== 0) throw new Error("Synthetic account has a queued or recorded delivery.");
    const jobTables = await db.query(
      `select table_name, column_name from information_schema.columns
       where table_schema='public' and table_name ilike '%job%'
       and column_name in ('manager_user_id','workspace_id') order by table_name,column_name`,
    );
    const checked = new Set<string>();
    for (const row of jobTables.rows as Array<{ table_name: string; column_name: string }>) {
      if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name) || !["manager_user_id", "workspace_id"].includes(row.column_name)) {
        throw new Error("Unsupported job-table catalog entry.");
      }
      const key = `${row.table_name}.${row.column_name}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const value = row.column_name === "manager_user_id" ? input.userId : workspaceId;
      const result = await db.query(`select count(*)::int as count from public."${row.table_name}" where "${row.column_name}"::text=$1`, [value]);
      if (result.rows[0]?.count !== 0) throw new Error("Synthetic manager has a queued job.");
    }
    await db.query("ROLLBACK");

    // Only the two-table phone-ownership check and this exact null->timestamp
    // marker write hold locks; the wider graph inspection above is read-only.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("LOCK TABLE auth.users, public.profiles IN SHARE ROW EXCLUSIVE MODE");
    const lockedAuth = await db.query(
      "select email,email_confirmed_at is not null as confirmed,raw_app_meta_data->>'proplane_email_onboarding' as onboarding_provenance from auth.users where id=$1",
      [input.userId],
    );
    if (lockedAuth.rows.length !== 1 || String(lockedAuth.rows[0]?.email).toLowerCase() !== input.email || lockedAuth.rows[0]?.confirmed !== true || lockedAuth.rows[0]?.onboarding_provenance !== "true") {
      throw new Error("Synthetic Auth provenance changed before marker write.");
    }
    const otherAuthPhones = await db.query("select count(*)::int as count from auth.users where phone=$1 and id<>$2", [input.phone, input.userId]);
    const otherProfilePhones = await db.query("select count(*)::int as count from public.profiles where phone=$1 and id<>$2", [input.phone, input.userId]);
    if (otherAuthPhones.rows[0]?.count !== 0 || otherProfilePhones.rows[0]?.count !== 0) throw new Error("Synthetic phone is already present on another account.");
    const exactProfile = await db.query("select email,phone,phone_verified_at from public.profiles where id=$1", [input.userId]);
    if (exactProfile.rows.length !== 1 || String(exactProfile.rows[0]?.email).toLowerCase() !== input.email || exactProfile.rows[0]?.phone !== input.phone || exactProfile.rows[0]?.phone_verified_at != null) {
      throw new Error("Synthetic phone state changed before marker write.");
    }
    const updated = await db.query(
      "update public.profiles set phone_verified_at=now() where id=$1 and email=$2 and phone=$3 and phone_verified_at is null returning id",
      [input.userId, input.email, input.phone],
    );
    if (updated.rowCount !== 1) throw new Error("Exact synthetic phone marker write did not match one profile.");
    await db.query("COMMIT");
    return { workspaceId };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

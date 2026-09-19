import { createClient } from "@supabase/supabase-js";

const DEV_TEST_SUPABASE_HOST = "emstjswhotsnyksqhqyf.supabase.co";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNED_EMAIL_PATTERN =
  /^[a-z0-9-]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@test\.proplane\.local$/;

function exactIdentityArguments(): { userId: string; email: string } {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--user-id" || args[2] !== "--email") {
    throw new Error("Owned signup cleanup requires exactly --user-id <uuid> --email <generated-email>.");
  }
  const userId = args[1]?.trim() ?? "";
  const email = args[3]?.trim() ?? "";
  if (!userId || !email || email !== email.toLowerCase()) {
    throw new Error("Owned signup cleanup requires a canonical UUID and lowercase generated email.");
  }
  return { userId, email };
}

function exactDevTestTarget(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !serviceKey) throw new Error("Owned signup cleanup requires dev/test service credentials.");

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("Owned signup cleanup received an invalid Supabase URL.");
  }
  if (
    target.protocol !== "https:" ||
    target.hostname.toLowerCase() !== DEV_TEST_SUPABASE_HOST ||
    target.port ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error(`Owned signup cleanup only targets ${DEV_TEST_SUPABASE_HOST}.`);
  }
  return { url, serviceKey };
}

async function main(): Promise<void> {
  const { userId, email } = exactIdentityArguments();
  if (!UUID_PATTERN.test(userId)) throw new Error("Owned signup cleanup requires an exact UUID user id.");
  if (!OWNED_EMAIL_PATTERN.test(email)) {
    throw new Error("Owned signup cleanup requires a generated test.proplane.local identity.");
  }

  const target = exactDevTestTarget();
  const db = createClient(target.url, target.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) {
    throw new Error(`Owned signup cleanup could not resolve the exact Auth UUID: ${error?.message ?? "absent"}`);
  }
  if (data.user.id !== userId || data.user.email?.trim().toLowerCase() !== email) {
    throw new Error("Owned signup cleanup refused because the UUID and generated email do not identify the same user.");
  }

  const { deletePortalAccountCompletely } = await import("@/lib/auth/delete-portal-account");
  await deletePortalAccountCompletely(db as never, userId);

  const remaining = await db.auth.admin.getUserById(userId);
  if (remaining.data.user) throw new Error("Owned signup cleanup did not remove the exact Auth UUID.");
  if (!remaining.error || remaining.error.code !== "user_not_found") {
    throw new Error("Owned signup cleanup could not prove the exact Auth UUID is absent.");
  }
}

main().catch(() => {
  // The parent reports only bounded process metadata plus the generated email.
  // Do not print provider errors, which can carry product internals.
  console.error("Owned manager signup cleanup process failed.");
  process.exitCode = 1;
});

import type { SupabaseClient } from "@supabase/supabase-js";

function digitsOf(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function phoneVariants(raw: string): string[] {
  const d = digitsOf(raw);
  if (d.length !== 10) return [raw.trim()].filter(Boolean);
  return [
    `+1${d}`,
    d,
    `1${d}`,
    `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
    `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
    raw.trim(),
  ].filter(Boolean);
}

type WorkNumberRow = {
  manager_user_id: string | null;
  messaging_service_sid: string | null;
  provision_state: string | null;
  grace_expires_at: string | null;
  updated_at: string | null;
};

function isUsableProvision(row: WorkNumberRow): boolean {
  const graceActive =
    row.grace_expires_at && Date.parse(String(row.grace_expires_at)) > Date.now();
  return (
    row.provision_state === "active" ||
    row.provision_state === "provisioning" ||
    Boolean(graceActive)
  );
}

function pickUniqueOwner(
  rows: WorkNumberRow[],
  preferredServiceSid: string | null,
): { managerId: string; messagingServiceSid: string } | null {
  const candidates = rows.filter(isUsableProvision);
  if (candidates.length === 0) return null;

  const preferred = preferredServiceSid
    ? candidates.filter(
        (row) => String(row.messaging_service_sid ?? "").trim() === preferredServiceSid,
      )
    : candidates;
  const pool = preferred.length > 0 ? preferred : candidates;

  // A recycled or duplicated assignment is unsafe to guess.
  if (pool.length !== 1) return null;
  const row = pool[0];
  const managerId = String(row.manager_user_id ?? "").trim();
  if (!managerId) return null;
  const messagingServiceSid =
    String(row.messaging_service_sid ?? "").trim() || preferredServiceSid || "";
  // Callers always need a Messaging Service id for outbound; borrow the
  // deployment SID when the row has not stored one yet (pre-attachment).
  return messagingServiceSid ? { managerId, messagingServiceSid } : null;
}

/**
 * Resolve which manager owns the dialed/texted work number.
 *
 * Prefer rows attached to this deployment's Messaging Service. When that filter
 * yields nothing (number purchased / carrier-registered but not yet attached,
 * or SID still null while Status reads "Approval in progress"), fall back to a
 * unique phone match on a usable provision state so inbound SMS is not silently
 * discarded — Twilio already delivered to the handset.
 */
export async function resolveOwnedWorkNumber(
  db: SupabaseClient,
  toPhone: string,
): Promise<{ managerId: string; messagingServiceSid: string } | null> {
  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
  // Without a deployment Messaging Service, ownership cannot be tied to this
  // runtime — same fail-closed posture as the previous SID-only lookup.
  if (!expectedServiceSid) return null;
  const variants = phoneVariants(toPhone);
  if (variants.length === 0) return null;

  const selectCols =
    "manager_user_id, messaging_service_sid, provision_state, grace_expires_at, updated_at";

  if (expectedServiceSid) {
    const { data, error } = await db
      .from("manager_sms_numbers")
      .select(selectCols)
      .in("phone_number", variants)
      .eq("messaging_service_sid", expectedServiceSid)
      .order("updated_at", { ascending: false })
      .limit(10);
    if (!error) {
      const owned = pickUniqueOwner((data ?? []) as WorkNumberRow[], expectedServiceSid);
      if (owned) return owned;
    }
  }

  // Phone-only fallback: inbound can arrive on a number that is not yet linked
  // to TWILIO_MESSAGING_SERVICE_SID (attachment / registration still pending).
  const { data: byPhone, error: byPhoneError } = await db
    .from("manager_sms_numbers")
    .select(selectCols)
    .in("phone_number", variants)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (byPhoneError) return null;
  return pickUniqueOwner((byPhone ?? []) as WorkNumberRow[], expectedServiceSid);
}

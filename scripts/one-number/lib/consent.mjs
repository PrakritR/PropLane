import { fetchAll } from "./db.mjs";
import { phoneKey } from "./phones.mjs";

/**
 * Phone keys (10-digit US) that are opted out right now, by the same rule as `readSmsSuppressionState`
 * (src/lib/sms-consent.ts): the latest opt-in anywhere beats an older opt-out anywhere. Reads the global
 * ledger (`sms_consent`) and the per-account profile flags.
 */
export async function optedOutKeys(db) {
  const out = new Set();
  const ledger = await fetchAll(db, "sms_consent", "phone, opted_in_at, opted_out_at", { key: "phone" });
  for (const r of ledger.rows) {
    if (r.opted_out_at && (!r.opted_in_at || Date.parse(r.opted_in_at) < Date.parse(r.opted_out_at))) out.add(phoneKey(r.phone));
  }
  const profiles = await fetchAll(db, "profiles", "id, phone, sms_opt_out_at, sms_consent_at", { filter: (q) => q.not("sms_opt_out_at", "is", null) });
  for (const r of profiles.rows) {
    if (r.phone && (!r.sms_consent_at || Date.parse(r.sms_consent_at) < Date.parse(r.sms_opt_out_at))) out.add(phoneKey(r.phone));
  }
  out.delete("");
  return out;
}

/** Phone keys whose latest scoped consent evidence for a manager is a revoke (any purpose): never text them a notice. */
export async function scopedRevokedKeys(db) {
  const events = await fetchAll(db, "sms_consent_events", "id, recipient_phone_key, manager_user_id, purpose, send_class, conversation_key, event_type, occurred_at, created_at");
  const latest = new Map();
  for (const e of events.rows) {
    const k = [e.recipient_phone_key, e.manager_user_id, e.purpose, e.send_class, e.conversation_key ?? ""].join("|");
    const prior = latest.get(k);
    const at = Date.parse(e.occurred_at ?? e.created_at ?? 0) || 0;
    if (!prior || at >= prior.at) latest.set(k, { at, type: e.event_type, phone: e.recipient_phone_key, manager: e.manager_user_id });
  }
  const out = new Set();
  for (const v of latest.values()) if (v.type === "revoked") out.add(`${v.manager}|${v.phone}`);
  return out;
}

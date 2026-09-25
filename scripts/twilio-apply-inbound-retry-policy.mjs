#!/usr/bin/env node
/**
 * Add the inbound 5xx retry policy (`#rp=ct,5xx&rc=2`) to live Twilio webhooks
 * that point at /api/twilio/inbound. New numbers get it at provisioning
 * (`withInboundRetryPolicy` in src/lib/twilio-provisioning.ts); this backfills
 * numbers bought before that, plus the Messaging Service inbound URL when the
 * service does not defer to the number's webhook.
 *
 * Dry run by default. Credentials come from the environment the caller loads:
 *   node --env-file=<twilio env file> scripts/twilio-apply-inbound-retry-policy.mjs
 *   node --env-file=<twilio env file> scripts/twilio-apply-inbound-retry-policy.mjs --apply
 *
 * The fragment is not part of Twilio's request signature, so signature
 * validation is unaffected. Only the fragment changes; host and path are kept.
 */

import twilio from "twilio";

// Keep in sync with TWILIO_INBOUND_RETRY_FRAGMENT (guarded by a unit test).
export const RETRY_FRAGMENT = "#rp=ct,5xx&rc=2";
const INBOUND_PATH = "/api/twilio/inbound";

export function withRetryPolicy(url) {
  return `${String(url).split("#")[0]}${RETRY_FRAGMENT}`;
}

/** True for our inbound webhook that does not already carry the policy. */
export function needsRetryPolicy(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(String(url).split("#")[0]);
  } catch {
    return false;
  }
  return parsed.pathname === INBOUND_PATH && String(url) !== withRetryPolicy(url);
}

function client() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const keySid = process.env.TWILIO_API_KEY_SID?.trim();
  const keySecret = process.env.TWILIO_API_KEY_SECRET?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid) throw new Error("TWILIO_ACCOUNT_SID is not set.");
  if (keySid && keySecret) return twilio(keySid, keySecret, { accountSid });
  if (authToken) return twilio(accountSid, authToken);
  throw new Error("Set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET or TWILIO_AUTH_TOKEN.");
}

function masked(phone) {
  return String(phone ?? "").replace(/\d(?=\d{4})/g, "•");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const api = client();
  const changes = [];

  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (serviceSid) {
    const service = await api.messaging.v1.services(serviceSid).fetch();
    if (service.useInboundWebhookOnNumber) {
      console.log(`Messaging Service ${serviceSid}: defers to each number's webhook.`);
    } else if (needsRetryPolicy(service.inboundRequestUrl)) {
      changes.push({
        label: `Messaging Service ${serviceSid} inbound URL`,
        from: service.inboundRequestUrl,
        run: () => api.messaging.v1.services(serviceSid).update({ inboundRequestUrl: withRetryPolicy(service.inboundRequestUrl) }),
      });
    } else {
      console.log(`Messaging Service ${serviceSid}: inbound URL ${service.inboundRequestUrl || "(none)"} needs no change.`);
    }
  }

  const numbers = await api.incomingPhoneNumbers.list({ pageSize: 1000 });
  for (const number of numbers) {
    if (!needsRetryPolicy(number.smsUrl)) continue;
    changes.push({
      label: `Number ${masked(number.phoneNumber)} (${number.sid})`,
      from: number.smsUrl,
      run: () => api.incomingPhoneNumbers(number.sid).update({ smsUrl: withRetryPolicy(number.smsUrl) }),
    });
  }

  console.log(`${numbers.length} numbers scanned; ${changes.length} webhook(s) need the retry policy.`);
  let failed = 0;
  for (const change of changes) {
    console.log(`${apply ? "update" : "would update"}: ${change.label}\n  ${change.from}\n  -> ${withRetryPolicy(change.from)}`);
    if (!apply) continue;
    try {
      await change.run();
    } catch (error) {
      failed += 1;
      console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!apply && changes.length) console.log("\nDry run. Re-run with --apply to write.");
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

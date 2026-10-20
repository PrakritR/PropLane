import "server-only";

import { cache } from "react";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  createTtlCache,
  serverSnapshotCacheEnabled,
} from "@/lib/server-ttl-cache";
import {
  publicTextingConfig,
  type PublicTextingConfig,
} from "@/lib/marketing/public-texting";

const snapshot = createTtlCache<PublicTextingConfig>(60_000);

async function readPublicTextingConfig(): Promise<PublicTextingConfig> {
  const { data, error } = await createSupabaseServiceRoleClient()
    .from("sms_runtime_config")
    .select("line_mode,shared_number_e164")
    .eq("singleton", true)
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle();
  if (error) throw new Error("Public texting configuration unavailable.");
  // Shadow is the captain-approved public launch mode; transport routing remains unchanged.
  return publicTextingConfig(
    data && ["shared", "shadow"].includes(data.line_mode)
      ? data.shared_number_e164
      : null,
  );
}

/**
 * The last number a read actually returned, kept for the life of the instance. A slow or failing read (the dev
 * database under load, a cold lambda) must never take the homepage's text button away: the page is served
 * this at once and the read refreshes it behind the request. Only a completed read sets or clears it.
 */
let lastGood: PublicTextingConfig | null = null;

/** The operator-configured public number (PROPLANE_PUBLIC_SMS_NUMBER): what the text button shows when no read gives one. */
function configuredFallback(): PublicTextingConfig {
  return publicTextingConfig(process.env.PROPLANE_PUBLIC_SMS_NUMBER ?? null);
}

async function readSnapshot(): Promise<PublicTextingConfig> {
  const config = serverSnapshotCacheEnabled()
    ? await snapshot.get("shared-number", readPublicTextingConfig)
    : await readPublicTextingConfig();
  // A completed read is authoritative either way: a mode with no public line clears what an earlier read kept.
  lastGood = config.phone ? config : null;
  return config;
}

/**
 * How long the first request on an instance waits for the live read before the configured number answers. A cold
 * Supabase round trip (TCP + TLS + query) routinely passes half a second, and the instance can be frozen right
 * after the response, so nothing may ever fill `lastGood`: the budget has to be long enough that the real number
 * normally wins, while staying far under the read's own five-second timeout.
 */
export const PUBLIC_TEXTING_COLD_START_BUDGET_MS = 1_500;

/** The read's answer if it lands inside the budget, else null. The read itself keeps going and fills `lastGood`. */
async function withColdStartBudget(read: Promise<PublicTextingConfig>): Promise<PublicTextingConfig | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PUBLIC_TEXTING_COLD_START_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One public snapshot, with request-level coalescing and no cached read failures. The homepage's text button is
 * never taken away (captain #21): a completed read with a public line is the answer; a mode with no public
 * line (its shared number is never advertised) or a failed read with nothing kept falls back to the operator's
 * configured public number; a failed read with a kept number serves that.
 */
export const getPublicTextingConfig = cache(
  async (): Promise<PublicTextingConfig> => {
    if (lastGood && serverSnapshotCacheEnabled()) {
      const served = lastGood;
      void readSnapshot().catch(() => undefined);
      return served;
    }
    // Nothing kept yet (a cold instance): the read gets a short budget and then the configured number answers
    // while it finishes in the background. Awaiting it outright blocked the homepage and every auth page for up
    // to the read's own five-second timeout, which is the opposite of "the text button is never taken away".
    const read = readSnapshot();
    read.catch(() => undefined);
    try {
      const config = await withColdStartBudget(read);
      return config?.phone ? config : configuredFallback();
    } catch {
      return lastGood ?? configuredFallback();
    }
  },
);

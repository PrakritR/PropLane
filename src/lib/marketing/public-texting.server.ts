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
    .abortSignal(AbortSignal.timeout(800))
    .maybeSingle();
  if (error) throw new Error("Public texting configuration unavailable.");
  // Shadow is the captain-approved public launch mode; transport routing remains unchanged.
  return publicTextingConfig(
    data && ["shared", "shadow"].includes(data.line_mode)
      ? data.shared_number_e164
      : null,
  );
}

/** One public snapshot, with request-level coalescing and no cached read failures. */
export const getPublicTextingConfig = cache(
  async (): Promise<PublicTextingConfig> => {
    try {
      return serverSnapshotCacheEnabled()
        ? await snapshot.get("shared-number", readPublicTextingConfig)
        : await readPublicTextingConfig();
    } catch {
      return publicTextingConfig(null);
    }
  },
);

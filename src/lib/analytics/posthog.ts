/**
 * Server-side PostHog product analytics. No-ops when POSTHOG_KEY is unset, so it
 * is safe to call anywhere. Uses the `object_action` event convention. Never
 * pass PII or secrets as properties — identify by user id only.
 */
import { after } from "next/server";
import { PostHog } from "posthog-node";

let client: PostHog | null = null;
let initialized = false;

function getClient(): PostHog | null {
  if (initialized) return client;
  initialized = true;
  // `||` not `??`: an empty-string POSTHOG_KEY must fall back to the public token.
  const key = (process.env.POSTHOG_KEY?.trim() || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()) ?? "";
  if (!key) return (client = null);
  const host =
    process.env.POSTHOG_HOST?.trim() || process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
  client = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  return client;
}

/** Emit a product-analytics event. Distinct id is the user id; props must be non-PII. */
export function track(
  event: string,
  distinctId: string,
  properties: Record<string, string | number | boolean> = {},
): void {
  try {
    const ph = getClient();
    if (!ph) return;
    ph.capture({ distinctId, event, properties });
    after(async () => {
      try {
        await ph.flush();
      } catch {
        /* analytics must never break a request */
      }
    });
  } catch {
    /* analytics must never break a request */
  }
}

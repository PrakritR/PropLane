import "server-only";
import { isShieldedRecipient } from "@/lib/protected-accounts.server";

/**
 * Outbound email shield, installed once at server start.
 *
 * Email has no single send helper: thirty modules POST to the Resend API
 * directly, and a new one lands every few weeks. Guarding each call site would
 * miss the next one, so the guard sits at the transport instead - the one place
 * every current and future sender has to pass through.
 *
 * Only Resend URLs are inspected. Everything else, the Supabase calls this
 * shield itself makes included, passes straight through, so there is no
 * recursion.
 */
const RESEND_HOST = "api.resend.com";

declare global {
  var __axisProtectedAccountShieldInstalled: boolean | undefined;
}

function recipientsFrom(payload: unknown): string[] {
  const entries = Array.isArray(payload) ? payload : [payload];
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    for (const field of ["to", "cc", "bcc"] as const) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === "string"));
    }
  }
  return out;
}

/** A recipient can be a bare address or "Name <addr@example.com>". */
function addressOf(recipient: string): string {
  const angled = recipient.match(/<([^>]+)>/);
  return (angled ? angled[1] : recipient).trim().toLowerCase();
}

export function installProtectedAccountFetchShield(): void {
  if (globalThis.__axisProtectedAccountShieldInstalled) return;
  globalThis.__axisProtectedAccountShieldInstalled = true;

  const original = globalThis.fetch;
  globalThis.fetch = async function shieldedFetch(input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    } catch {
      return original(input as RequestInfo, init);
    }
    if (!url.includes(RESEND_HOST)) return original(input as RequestInfo, init);

    let recipients: string[] = [];
    try {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof body === "string" && body) recipients = recipientsFrom(JSON.parse(body));
    } catch {
      // An unreadable Resend body is not a reason to let it through.
      recipients = [];
    }

    for (const recipient of recipients) {
      if (await isShieldedRecipient({ email: addressOf(recipient) })) {
        console.error(
          "protected-accounts: blocked an outbound email to a protected account " +
            `from a non-production runtime (${recipients.length} recipient(s)).`,
        );
        return new Response(
          JSON.stringify({
            name: "protected_account_shielded",
            message:
              "Refused: this recipient belongs to an account with real customer data, " +
              "and this runtime is not production.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
    }
    return original(input as RequestInfo, init);
  } as typeof globalThis.fetch;

  // Next patches fetch for its own caching and hangs statics off it. Carry them
  // across so wrapping the function does not quietly drop that behavior.
  Object.defineProperties(
    globalThis.fetch,
    Object.getOwnPropertyDescriptors(original as unknown as object),
  );
}

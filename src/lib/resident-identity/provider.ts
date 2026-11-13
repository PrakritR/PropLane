/**
 * Which provider verifies an applicant's government ID.
 *
 * - `checkr` (DEFAULT): Checkr's ID-verification add-on (government ID + live selfie, billed with the
 *   screening order). Checkr is a consumer reporting agency, so the FCRA disclosure and authorization
 *   the applicant gives before the order apply to it. The ID check rides the screening order and is a
 *   PRE-APPLY requirement the manager chooses per listing (`screening/preapply.ts`); the global baseline
 *   gate (`resolveBaselineResidentIdentity`) answers "disabled" for it.
 * - `persona`: the existing Persona inquiry flow (`persona.server.ts`), only when its keys exist.
 *
 * Stripe Identity is deliberately NOT a provider. Its activation terms bar using it "to determine
 * eligibility for any purpose covered by the US Fair Credit Reporting Act (FCRA)", and tenant screening
 * is such a purpose. `RESIDENT_IDENTITY_PROVIDER=stripe` therefore resolves to `null` (unavailable,
 * fail closed), never to a working provider. If it is ever added it may only back non-eligibility
 * fraud/trust checks, never applications, screening or lease decisions.
 */
export type ResidentIdentityProviderId = "checkr" | "persona";

export function residentIdentityProvider(
  env: Record<string, string | undefined> = process.env,
): ResidentIdentityProviderId | null {
  const raw = env.RESIDENT_IDENTITY_PROVIDER?.trim().toLowerCase();
  if (!raw) return "checkr";
  return raw === "checkr" || raw === "persona" ? raw : null;
}

/**
 * Can the applicant ID check be offered right now? Fails closed: the master switch must be on, the provider must be
 * the supported Checkr one, and Checkr must be configured. Anything else is "ID check unavailable" and nobody is
 * ever marked verified. (Persona keeps its own gate in `persona.server.ts`.)
 */
export function applicantIdCheckAvailable(env: Record<string, string | undefined> = process.env): boolean {
  if (env.RESIDENT_IDENTITY_ENABLED !== "true") return false;
  if (residentIdentityProvider(env) !== "checkr") return false;
  // Same rule as `backgroundCheckConfigured()` (key, or the local simulate switch), read from the env we were given.
  const key = (env.CHECKR_API_KEY ?? env.BACKGROUND_CHECK_API_KEY)?.trim();
  const simulate = ["1", "true", "yes"].includes(env.CHECKR_SIMULATE?.trim().toLowerCase() ?? "");
  return Boolean(key) || simulate;
}

/** Persona's three secrets are all present (the same rule as `personaEnabled()`, minus the provider switch). */
export function personaConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PERSONA_API_KEY?.trim() && env.PERSONA_TEMPLATE_ID?.trim() && env.PERSONA_WEBHOOK_SECRET?.trim());
}

/**
 * Which provider verifies an applicant's ID BEFORE they apply, and whether the feature is on at all.
 *
 * - `enabled` is the master switch (`RESIDENT_IDENTITY_ENABLED=true`). Off means the ID check is not part of the
 *   product in this environment and no requirement is enforced (the same rule as `resolveBaselineResidentIdentity`).
 * - `provider` is `null` when enabled but nothing can actually verify (an unknown provider such as "stripe", Persona
 *   without its keys, Checkr without its key): "ID check unavailable", fail closed, nobody is marked verified.
 * - `persona` is the standalone Persona flow (no background order needed); `checkr` is Checkr's ID add-on, which only
 *   exists inside an order.
 */
export function applicantIdCheckProvider(
  env: Record<string, string | undefined> = process.env,
): { enabled: boolean; provider: ResidentIdentityProviderId | null } {
  const enabled = env.RESIDENT_IDENTITY_ENABLED === "true";
  if (!enabled) return { enabled: false, provider: null };
  const provider = residentIdentityProvider(env);
  if (provider === "persona") return { enabled, provider: personaConfigured(env) ? "persona" : null };
  if (provider === "checkr") return { enabled, provider: applicantIdCheckAvailable(env) ? "checkr" : null };
  return { enabled, provider: null };
}

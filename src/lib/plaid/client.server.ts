import "server-only";

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export type PlaidEnvName = "sandbox" | "production";

export const PLAID_PURPOSES = ["bank_feed", "resident_pay", "income"] as const;
export type PlaidPurpose = (typeof PLAID_PURPOSES)[number];

/** Purposes whose product flow is built. The others plug in later without a schema change. */
export const PLAID_ENABLED_PURPOSES: readonly PlaidPurpose[] = ["bank_feed", "resident_pay"];

export function isPlaidPurpose(value: unknown): value is PlaidPurpose {
  return typeof value === "string" && (PLAID_PURPOSES as readonly string[]).includes(value);
}

type PlaidConfig = { clientId: string; secret: string; env: PlaidEnvName };

function readConfig(env: NodeJS.ProcessEnv = process.env): PlaidConfig | null {
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  const plaidEnv = env.PLAID_ENV?.trim().toLowerCase();
  if (!clientId || !secret) return null;
  if (plaidEnv !== "sandbox" && plaidEnv !== "production") return null;
  return { clientId, secret, env: plaidEnv };
}

/** False when any key is absent or PLAID_ENV is not sandbox|production: every Plaid control stays hidden. */
export function plaidEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readConfig(env) !== null;
}

export function plaidEnvName(env: NodeJS.ProcessEnv = process.env): PlaidEnvName | null {
  return readConfig(env)?.env ?? null;
}

let cached: { key: string; client: PlaidApi } | null = null;

/** The one Plaid client. Throws (without echoing any key) when Plaid is disabled. */
export function getPlaidClient(env: NodeJS.ProcessEnv = process.env): PlaidApi {
  const config = readConfig(env);
  if (!config) throw new Error("Plaid is not configured.");
  const key = `${config.env}:${config.clientId}:${config.secret.length}`;
  if (cached?.key === key) return cached.client;
  const client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.env],
      baseOptions: {
        headers: { "PLAID-CLIENT-ID": config.clientId, "PLAID-SECRET": config.secret },
        timeout: 20_000,
      },
    }),
  );
  cached = { key, client };
  return client;
}

export type PlaidFailure = { code: string; type: string; message: string; status?: number };

/**
 * Reduce any thrown Plaid/axios error to its public error body. An axios error carries the
 * request config (headers with the secret), so callers must log THIS, never the raw error.
 */
export function plaidFailure(error: unknown): PlaidFailure {
  const response = (error as { response?: { data?: Record<string, unknown>; status?: number } } | null)?.response;
  const data = response?.data;
  if (data && typeof data === "object") {
    return {
      code: typeof data.error_code === "string" ? data.error_code : "UNKNOWN",
      type: typeof data.error_type === "string" ? data.error_type : "UNKNOWN",
      message: typeof data.error_message === "string" ? data.error_message : "Plaid request failed.",
      status: response?.status,
    };
  }
  return { code: "UNREACHABLE", type: "NETWORK", message: "Plaid could not be reached." };
}

/** True only for an error Plaid itself answered with (an axios error carrying Plaid's JSON error body). */
export function isPlaidShapedError(error: unknown): boolean {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  return Boolean(data && typeof data === "object" && typeof (data as { error_code?: unknown }).error_code === "string");
}

/**
 * True for an error that came out of the HTTP client, whether or not Plaid answered it: a timeout, a
 * DNS or TLS failure, a 5xx with an HTML body. `AxiosError` keeps `config` / `request` /
 * `response.config` as OWN ENUMERABLE properties, and the Plaid client's config headers hold
 * `PLAID-SECRET`, so `util.inspect` would print the live secret. Such an error is never logged whole.
 */
export function isTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  return e.isAxiosError === true || "config" in e || "request" in e || "response" in e;
}

/**
 * The one way a Plaid route logs a failure.
 *
 * Nothing that touched the HTTP client is ever logged whole — not even a transport failure, whose
 * axios error carries the request config with the secret header. Those are reduced to their public
 * code plus the transport code, status and message. Anything else (Stripe, the database, a bug) holds
 * no Plaid credential and `plaidFailure` would flatten it to `UNREACHABLE` with nothing left to
 * debug, so it is logged in full.
 */
export function logPlaidFailure(label: string, error: unknown): void {
  if (isPlaidShapedError(error)) {
    console.warn(label, plaidFailure(error).code);
    return;
  }
  if (isTransportError(error)) {
    const e = error as { code?: unknown; message?: unknown; response?: { status?: unknown } };
    console.warn(label, plaidFailure(error).code, {
      transport: typeof e.code === "string" ? e.code : "UNKNOWN",
      status: typeof e.response?.status === "number" ? e.response.status : null,
      message: typeof e.message === "string" ? e.message.slice(0, 300) : "",
    });
    return;
  }
  console.error(`${label} (not a Plaid error)`, error);
}

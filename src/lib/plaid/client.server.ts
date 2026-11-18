import "server-only";

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export type PlaidEnvName = "sandbox" | "production";

export const PLAID_PURPOSES = ["bank_feed", "resident_pay", "income"] as const;
export type PlaidPurpose = (typeof PLAID_PURPOSES)[number];

/** Purposes whose product flow is built. The others plug in later without a schema change. */
export const PLAID_ENABLED_PURPOSES: readonly PlaidPurpose[] = ["bank_feed"];

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

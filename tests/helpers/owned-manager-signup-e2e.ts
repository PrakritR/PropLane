import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";

const DEV_TEST_SUPABASE_HOST = "emstjswhotsnyksqhqyf.supabase.co";
const MANAGER_REGISTER_PATH = "/api/auth/manager-register";
const execFileAsync = promisify(execFile);
const OWNED_SIGNUP_CLEANUP_SCRIPT = path.resolve(
  process.cwd(),
  "tests/helpers/purge-owned-manager-signup.ts",
);

type ExactDevTestTarget = { url: string; serviceKey: string };

export type OwnedManagerSignup = {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  registration: OwnedManagerRegistration;
  cleanup: () => Promise<void>;
};

type ForwardedManagerRegistration =
  | { response: APIResponse; error: null }
  | { response: null; error: Error };

export type OwnedManagerRegistration = {
  submissionStarted: boolean;
  forward: Promise<ForwardedManagerRegistration> | null;
  requestContext: APIRequestContext | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function registrationError(email: string, message: string): Error {
  return new Error(`Manager signup registration for owned identity ${email} ${message}`);
}

function exactOwnedRegistrationBody(account: OwnedManagerSignup, body: unknown): Error | null {
  if (!body || typeof body !== "object") return registrationError(account.email, "sent a non-object request body.");
  const request = body as Record<string, unknown>;
  if (request.email !== account.email) return registrationError(account.email, "did not send the exact owned email.");
  if (request.password !== account.password) return registrationError(account.email, "did not send the exact owned password.");
  if (request.fullName !== account.fullName) return registrationError(account.email, "did not send the exact owned full name.");
  if (request.phone !== account.phone) return registrationError(account.email, "did not send the exact owned phone.");
  return null;
}

function exactDevTestTarget(): ExactDevTestTarget | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !serviceKey) return null;
  try {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.hostname.toLowerCase() !== DEV_TEST_SUPABASE_HOST ||
      target.port ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { url, serviceKey };
}

function requireExactDevTestTarget(): ExactDevTestTarget {
  const target = exactDevTestTarget();
  if (!target) {
    throw new Error(
      `Manager signup fixtures only write to the exact dev/test project (${DEV_TEST_SUPABASE_HOST}) with a service key.`,
    );
  }
  return target;
}

async function exactAuthUserByEmail(db: SupabaseClient, email: string) {
  const id = await findAuthUserIdByEmail(db, email);
  if (!id) return null;
  const { data, error } = await db.auth.admin.getUserById(id);
  if (error || !data.user) {
    throw new Error(`Could not inspect owned manager signup identity: ${error?.message ?? "user is absent"}`);
  }
  const normalized = email.toLowerCase();
  if (data.user.email?.trim().toLowerCase() !== normalized) {
    throw new Error("Manager signup identity lookup returned an email different from the generated owner.");
  }
  return data.user;
}

async function purgeExactOwnedSignup(userId: string, email: string): Promise<void> {
  try {
    await execFileAsync(
      process.execPath,
      [
        "--max-old-space-size=512",
        "--conditions=react-server",
        "--import",
        "tsx",
        OWNED_SIGNUP_CLEANUP_SCRIPT,
        "--user-id",
        userId,
        "--email",
        email,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    // Child stderr can contain provider or product internals. Keep the owned
    // identity visible for reconciliation, but report only process metadata.
    const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const code = typeof failure.code === "number" || typeof failure.code === "string" ? failure.code : "unknown";
    const signal = typeof failure.signal === "string" ? failure.signal : "none";
    const killed = failure.killed === true ? "yes" : "no";
    throw new Error(
      `Owned manager signup cleanup failed for ${email} (code=${code}, signal=${signal}, killed=${killed}).`,
    );
  }
}

/**
 * Create a registration identity before the browser submits, then purge only
 * that exact Auth account through the application's full account-purge path.
 */
export async function createOwnedManagerSignup(prefix: string): Promise<OwnedManagerSignup> {
  const target = requireExactDevTestTarget();
  const db = createClient(target.url, target.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = randomUUID();
  const email = `${prefix}-${token}@test.proplane.local`.toLowerCase();
  const password = `E2E!${token}Aa1`;
  const fullName = "E2E Signup Manager";
  // All three manager signup surfaces send the phone body through unchanged.
  // Keeping the owned fixture in the route's canonical E.164 representation
  // lets the route fence reject a request that belongs to another account.
  const phone = "+12065550199";
  let ownedUserId: string | null = null;
  const registration: OwnedManagerRegistration = {
    submissionStarted: false,
    forward: null,
    requestContext: null,
  };

  if (await exactAuthUserByEmail(db, email)) {
    throw new Error("Generated manager signup identity already exists; no registration was submitted.");
  }

  return {
    email,
    password,
    fullName,
    phone,
    registration,
    cleanup: async () => {
      requireExactDevTestTarget();
      try {
        if (registration.submissionStarted) {
          const forward = registration.forward;
          if (!forward) {
            throw registrationError(
              email,
              "has indeterminate cleanup: the browser submitted it without a captured forwarded registration. The identity was not purged.",
            );
          }
          const completed = await forward;
          if (completed.error) {
            throw registrationError(
              email,
              `has indeterminate cleanup because the forwarded registration did not complete: ${completed.error.message}. The identity was not purged.`,
            );
          }
        }
        const user = await exactAuthUserByEmail(db, email);
        if (!user) return;
        if (ownedUserId && user.id !== ownedUserId) {
          throw new Error("Manager signup cleanup refused because the exact Auth identity changed.");
        }
        ownedUserId = user.id;
        // The product purge graph imports Next's server-only marker. Keep that
        // graph in a short-lived server-conditioned process so Playwright can
        // collect this browser helper without weakening server-only globally.
        await purgeExactOwnedSignup(user.id, email);
        const remaining = await exactAuthUserByEmail(db, email);
        if (remaining) throw new Error("Manager signup cleanup did not remove the exact generated Auth identity.");
      } finally {
        const requestContext = registration.requestContext;
        registration.requestContext = null;
        // A disposal failure must not replace the owned-identity transport or
        // cleanup error that tells validation which account remains unresolved.
        await requestContext?.dispose().catch(() => {});
      }
    },
  };
}

/**
 * Forward the intercepted request through a fixture-owned API request context.
 * It has its own lifetime, so callers can close their browser context before
 * cleanup drains the real server operation and purges the owned identity.
 */
export async function submitOwnedManagerRegistration(
  page: Page,
  submit: Locator,
  account: OwnedManagerSignup,
): Promise<void> {
  const forwardStarted = deferred<ForwardedManagerRegistration>();
  let started = false;

  await page.route(`**${MANAGER_REGISTER_PATH}`, async (route: Route) => {
    const interceptedRequest = route.request();
    if (interceptedRequest.method() !== "POST" || new URL(interceptedRequest.url()).pathname !== MANAGER_REGISTER_PATH) {
      await route.fallback();
      return;
    }
    if (started) {
      const error = registrationError(account.email, "attempted a second registration request.");
      forwardStarted.resolve({ response: null, error });
      await route.abort("blockedbyclient");
      return;
    }
    started = true;
    let bodyError: Error | null;
    try {
      bodyError = exactOwnedRegistrationBody(account, interceptedRequest.postDataJSON());
    } catch (error) {
      bodyError = registrationError(
        account.email,
        `could not read the intercepted request body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (bodyError) {
      const blocked = Promise.resolve<ForwardedManagerRegistration>({ response: null, error: bodyError });
      account.registration.forward = blocked;
      forwardStarted.resolve(await blocked);
      await route.abort("blockedbyclient");
      return;
    }

    const body = interceptedRequest.postData();
    const forward = (async (): Promise<ForwardedManagerRegistration> => {
      try {
        const headers = await interceptedRequest.allHeaders();
        const requestContext = await playwrightRequest.newContext({
          baseURL: new URL(interceptedRequest.url()).origin,
          extraHTTPHeaders: headers,
          timeout: 60_000,
        });
        account.registration.requestContext = requestContext;
        const response = await requestContext.fetch(interceptedRequest.url(), {
          method: interceptedRequest.method(),
          headers,
          data: body ?? undefined,
          maxRetries: 0,
          timeout: 60_000,
        });
        return { response, error: null };
      } catch (error) {
        return { response: null, error: error instanceof Error ? error : new Error(String(error)) };
      }
    })();
    account.registration.forward = forward;
    forwardStarted.resolve(await forward);
    const completed = await forward;
    if (completed.error) {
      await route.abort("failed").catch(() => {});
      return;
    }
    // The page may have been closed after a click failure. The independently
    // forwarded registration is already complete, so a now-undeliverable
    // browser response must not turn it into an unhandled route rejection.
    await route.fulfill({ response: completed.response }).catch(() => {});
  });

  account.registration.submissionStarted = true;
  try {
    await submit.click();
  } catch (clickError) {
    // A click can fail after dispatching a request. Keep cleanup fail-closed
    // until the independently forwarded operation has either completed or
    // reports its own transport failure.
    throw clickError;
  }
  let forwardStartTimer: ReturnType<typeof setTimeout> | undefined;
  const forwardStartTimeout = new Promise<ForwardedManagerRegistration>((resolve) => {
    forwardStartTimer = setTimeout(
      () =>
        resolve({
          response: null,
          error: registrationError(
            account.email,
            "did not complete a captured forwarded registration within 30 seconds. Cleanup will wait for its outcome before deciding whether purge is safe.",
          ),
        }),
      30_000,
    );
  });
  let startedForward: ForwardedManagerRegistration;
  try {
    startedForward = await Promise.race([forwardStarted.promise, forwardStartTimeout]);
  } finally {
    if (forwardStartTimer) clearTimeout(forwardStartTimer);
  }
  if (startedForward.error) throw startedForward.error;
  expect(
    startedForward.response.ok(),
    `Manager registration failed with HTTP ${startedForward.response.status()} for owned identity ${account.email}`,
  ).toBe(true);
}

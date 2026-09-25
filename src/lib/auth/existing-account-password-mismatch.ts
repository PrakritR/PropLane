/**
 * Client-safe home for this copy. `verify-auth-password.ts` (which performs
 * the actual check) imports `server-only` via `@/lib/server-env`, so a
 * client component that only needs the message text — never the check
 * itself — must not import it from there: doing so pulls the whole
 * server-only module graph into the client bundle and fails the build with
 * "You're importing a module that depends on server-only... in a Client
 * Component module." Keep this constant here and have both the server check
 * and the client form (`portal-auth-form.tsx`) import it from this file.
 */
export const EXISTING_ACCOUNT_PASSWORD_MISMATCH =
  "This email already has a PropLane account. Enter the same password you use for that account.";

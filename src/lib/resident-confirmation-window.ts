/**
 * Seven days: a resident should not be able to close or reopen a job from a month-old email or text.
 *
 * It lives in its own leaf module, not beside the confirmation server code, because both the
 * link/web path (`work-order-resident-confirmation.server.ts`) and the SMS path
 * (`vendor-dispatch/completion.server.ts`) have to agree on it — and that server module is mocked
 * wholesale by several suites, which would otherwise leave the SMS path with no window at all.
 */
export const RESIDENT_CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60_000;

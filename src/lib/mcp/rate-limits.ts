/**
 * Every rate limit on the MCP server and its OAuth endpoints, in one place so a limit and the client it must
 * fit are read together. A normal Claude client connecting does, in a few seconds: protected-resource and
 * authorization-server discovery (not limited: static JSON), one dynamic registration, one token exchange, then
 * `initialize`, `notifications/initialized`, `tools/list` and a handful of `tools/call`s. Claude's connector
 * traffic leaves from shared Anthropic addresses, so a per-IP limit on authenticated traffic is how a handful
 * of ordinary users used to read "Too Many Requests" (the old gate was 60/min/IP in front of every call).
 *
 * - Unauthenticated, per IP: dynamic registration (the only unauthenticated write) and the token endpoint.
 * - Failed credentials, per IP: guards guessing. Counts failures only.
 * - Authenticated, per grant: the OAuth token / API key, never the address.
 */
export const MCP_LIMITS = {
  windowMs: 60_000,
  /** Failed bearer lookups per IP per minute. A working client never spends this. */
  authFailuresPerIp: 30,
  /** Calls per key / OAuth token per minute (an abuse brake, not a billing quota). */
  callsPerGrant: 300,
  /** Dynamic client registrations per IP per minute: one per connect, with room for a shared egress address. */
  registerPerIp: 60,
  /** Token requests per IP per minute (code exchange + refreshes). */
  tokenPerIp: 120,
} as const;

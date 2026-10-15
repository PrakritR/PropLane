/**
 * One bounded-fetch signal for every caller, client included.
 *
 * `AbortSignal.timeout` only landed in Safari 17.4, so calling it unguarded in a
 * browser (the Capacitor shell runs an older WKWebView) throws before `fetch` is
 * ever issued and the read looks like a refusal. An unbounded fetch is still a
 * fetch, so a runtime without the API gets no signal rather than no request.
 */
export function requestTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return undefined;
  return AbortSignal.timeout(timeoutMs);
}

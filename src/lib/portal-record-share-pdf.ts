/**
 * Whether a stored value is safe to hand an iframe on a PUBLIC page.
 *
 * The value arrives from `row_data`, which the lease row's own resident can write, and the share
 * page is reachable by anyone holding the share URL. An unvalidated `src` therefore means a
 * `javascript:` or `data:text/html` payload stored by one party executes in PropLane's origin for
 * every recipient of the link — stored XSS with a delivery mechanism attached.
 *
 * This is an ALLOWLIST of the one scheme a PDF can legitimately use, not a denylist of the
 * schemes we happened to think of: an unrecognised value is refused rather than passed through.
 * `sandbox=""` on the element is the second layer, so neither control is load-bearing alone.
 *
 * It lives here, outside the `server-only` payload module, so the server (which decides what to
 * send) and the share page (which decides what to render) share ONE predicate — two copies drifted
 * once already, and a client copy that is looser than the server's is the unsafe direction.
 */
export function isSafeLeasePdfDataUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase().startsWith("data:application/pdf;base64,");
}

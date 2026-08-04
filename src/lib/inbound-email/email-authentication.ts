/**
 * Sender authentication for inbound email, read from the `Authentication-Results`
 * header the receiving MTA stamped.
 *
 * Why this exists: the Svix signature on a Resend inbound webhook proves Resend
 * delivered the message, NOT that the `From` is authentic. Everywhere else in
 * this codebase an emailed reply only appends to an in-app thread; the `sms+`
 * reply token sends a REAL text from a manager's business number in the
 * manager's own words, so a spoofed `From` there is rent-fraud shaped.
 *
 * ⚠️ **An `Authentication-Results` header is attacker-suppliable.** What comes
 * back from Resend's received-email API is the MESSAGE's header set, and a
 * sender may write as many A-R lines as they like — including
 * `dmarc=pass`. Two rules keep a forged line from ever GRANTING anything:
 *
 *   1. **Only the TOPMOST instance is read.** A receiving MTA prepends its own
 *      A-R above whatever the message already carried (RFC 8601 §5), so any
 *      line the sender wrote sits below a genuine one and is unreachable.
 *   2. **A pass is trusted only from a pinned authserv-id** — the receiver's
 *      own identity, configured in `RESEND_AUTHSERV_ID` (comma-separated for
 *      multiple MTAs). **Unset is the default and means no pass is ever
 *      trusted**, so the deployment has to opt into believing the header at
 *      all.
 *
 * The outcome therefore never says "this is definitely the manager" on a
 * header alone: `authenticated` is the only outcome that skips the interim
 * mitigations (single-use grant), and it requires the pinned identity. A
 * `reject` is safe to honour from any source — an attacker gains nothing by
 * writing a failure about themselves.
 *
 * `unauthenticated` is the ORDINARY outcome, not a refusal. With
 * `RESEND_AUTHSERV_ID` unset — the default — no pass is ever trusted, so every
 * reply lands here and is gated by the single-use grant instead. Treating it as
 * a refusal would take the whole email-reply leg offline by default, including
 * for a manager whose message carries a perfectly good verdict we simply have
 * no configured receiver to attribute. Setting the env buys the pinned
 * receiver's replies a pass straight through, nothing more.
 */

export type InboundEmailAuthOutcome =
  /** A pinned receiver stamped an aligned pass — trustworthy enough to skip the grant. */
  | "authenticated"
  /** An explicit aligned failure: the message claimed this domain and did not authenticate. */
  | "reject"
  /** Everything else: no header, nothing parseable, transient errors, or an untrusted pass. */
  | "unauthenticated";

export type AuthenticationMethodResult = {
  method: "spf" | "dkim" | "dmarc";
  result: string;
  props: Record<string, string>;
};

/** Domain half of an address, or of a bare domain. Always lowercase. */
export function emailDomainOf(value: string | null | undefined): string {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!raw) return "";
  const at = raw.lastIndexOf("@");
  const domain = at >= 0 ? raw.slice(at + 1) : raw;
  return domain.replace(/[>;,]+$/, "").trim();
}

/**
 * Relaxed alignment: identical domains, or one an ancestor of the other
 * (`mail.example.com` authenticates for `example.com`). Deliberately not an
 * organizational-domain (public-suffix) computation — no PSL is vendored here,
 * and a stricter answer only ever costs a fall-through to the grant path.
 */
export function domainsAligned(a: string, b: string): boolean {
  const left = emailDomainOf(a);
  const right = emailDomainOf(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/** Receivers whose stamped pass this deployment believes. Empty = believe none. */
export function trustedAuthservIds(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  return new Set(
    String(env.RESEND_AUTHSERV_ID ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

const METHOD_RE = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/;
const PROP_RE = /([a-z][\w.-]*)\s*=\s*([^\s;]+)/g;

/** Comments carry both `;` and `=` (`dmarc=pass (p=REJECT)`) — drop them first. */
function stripComments(raw: string): string {
  return raw.replace(/\([^()]*\)/g, " ");
}

/**
 * The authserv-id: the first token of the header, before any `;` or version
 * number. `""` when the header opens straight into a method result.
 */
export function parseAuthservId(header: string | null | undefined): string {
  const first = stripComments(String(header ?? "")).split(";")[0]?.trim().toLowerCase() ?? "";
  const token = first.split(/\s+/)[0] ?? "";
  return METHOD_RE.test(token) ? "" : token;
}

/** Parse ONE `Authentication-Results` header value into its method verdicts. */
export function parseAuthenticationResults(header: string | null | undefined): AuthenticationMethodResult[] {
  const raw = String(header ?? "");
  if (!raw.trim()) return [];
  const cleaned = stripComments(raw).toLowerCase();
  const out: AuthenticationMethodResult[] = [];
  for (const segment of cleaned.split(";")) {
    const part = segment.trim();
    const matched = METHOD_RE.exec(part);
    if (!matched) continue;
    const props: Record<string, string> = {};
    PROP_RE.lastIndex = 0;
    let prop: RegExpExecArray | null;
    while ((prop = PROP_RE.exec(part)) !== null) {
      const key = prop[1]!;
      if (key === matched[1]) continue;
      props[key] = prop[2]!;
    }
    out.push({ method: matched[1] as AuthenticationMethodResult["method"], result: matched[2]!, props });
  }
  return out;
}

/** Results that mean the verifier itself broke, not that the sender is forged. */
const TRANSIENT_RESULTS = new Set(["temperror", "permerror"]);
/** Results that assert the message did NOT authenticate as the domain it claimed. */
const FAILING_RESULTS = new Set(["fail", "softfail", "hardfail", "reject"]);

function hasAlignedPass(results: AuthenticationMethodResult[], fromDomain: string): boolean {
  for (const entry of results) {
    if (entry.result !== "pass") continue;
    if (entry.method === "dmarc") return true;
    if (entry.method === "dkim") {
      const signer = entry.props["header.d"] ?? entry.props["header.i"];
      if (signer && domainsAligned(signer, fromDomain)) return true;
      continue;
    }
    const envelope = entry.props["smtp.mailfrom"] ?? entry.props["smtp.helo"];
    if (envelope && domainsAligned(envelope, fromDomain)) return true;
  }
  return false;
}

/**
 * An explicit "did not authenticate as that domain": a DMARC failure, or SPF
 * and DKIM both failing. Honoured no matter who stamped it — forging a failure
 * about yourself only refuses your own message.
 */
function assertsFailure(results: AuthenticationMethodResult[]): boolean {
  const resultOf = (method: AuthenticationMethodResult["method"]): string | null =>
    results.find((entry) => entry.method === method)?.result ?? null;
  const dmarc = resultOf("dmarc");
  if (dmarc && FAILING_RESULTS.has(dmarc)) return true;
  const spf = resultOf("spf");
  const dkim = resultOf("dkim");
  return Boolean(spf && dkim && FAILING_RESULTS.has(spf) && FAILING_RESULTS.has(dkim));
}

/**
 * Assess the message's sender authentication.
 *
 * `headers` is every `Authentication-Results` value in received order; ONLY the
 * first (topmost, i.e. the last receiver to touch the message) is read — see
 * the module header for why the rest are ignored rather than merged.
 */
export function assessInboundEmailAuthentication(
  headers: string[] | string | null | undefined,
  fromEmail: string,
  env: Record<string, string | undefined> = process.env,
): InboundEmailAuthOutcome {
  const values = (Array.isArray(headers) ? headers : [headers ?? ""]).filter(
    (value) => String(value ?? "").trim().length > 0,
  );
  const topmost = values[0];
  const results = parseAuthenticationResults(topmost);
  if (results.length === 0) return "unauthenticated";

  if (assertsFailure(results)) return "reject";

  // A verifier that broke tells us nothing either way — same fail-open posture
  // the rest of the SMS stack takes on an infra error.
  if (results.every((entry) => TRANSIENT_RESULTS.has(entry.result))) return "unauthenticated";

  const fromDomain = emailDomainOf(fromEmail);
  if (!fromDomain) return "unauthenticated";

  const trusted = trustedAuthservIds(env);
  const authservId = parseAuthservId(topmost);
  if (trusted.size > 0 && authservId && trusted.has(authservId) && hasAlignedPass(results, fromDomain)) {
    return "authenticated";
  }
  return "unauthenticated";
}

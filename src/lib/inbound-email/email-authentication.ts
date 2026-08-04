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
 * The verdict is deliberately three-valued. Resend does not document an auth
 * verdict on the webhook payload, so `unknown` (no header available) is the
 * common case and must not read as either proof or forgery — the caller
 * falls back to a single-use reply grant. Only an explicit "this claimed to be
 * that domain and did not authenticate" is `fail`.
 */

export type InboundEmailAuthVerdict = "pass" | "fail" | "unknown";

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
 * and a stricter answer only ever falls back to the grant path.
 */
export function domainsAligned(a: string, b: string): boolean {
  const left = emailDomainOf(a);
  const right = emailDomainOf(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

const METHOD_RE = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/;
const PROP_RE = /([a-z][\w.-]*)\s*=\s*([^\s;]+)/g;

/**
 * Parse one or more `Authentication-Results` header values into method verdicts.
 * Parenthesised comments are stripped first — they routinely contain both `;`
 * and `=` (`dmarc=pass (p=REJECT sp=NONE)`), which would otherwise be read as
 * segments and properties.
 */
export function parseAuthenticationResults(header: string | null | undefined): AuthenticationMethodResult[] {
  const raw = String(header ?? "");
  if (!raw.trim()) return [];
  const cleaned = raw.replace(/\([^()]*\)/g, " ").toLowerCase();
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

/**
 * Does this header prove the message really came from `fromEmail`'s domain?
 *
 * `pass` needs an EXPLICIT aligned pass: DMARC pass (which is alignment by
 * definition), or an SPF/DKIM pass whose own domain aligns with the From
 * domain. An unaligned pass proves someone authenticated — just not as this
 * manager — so it is not a pass here.
 */
export function evaluateAuthenticationResults(
  header: string | null | undefined,
  fromEmail: string,
): InboundEmailAuthVerdict {
  const results = parseAuthenticationResults(header);
  if (results.length === 0) return "unknown";
  const fromDomain = emailDomainOf(fromEmail);
  if (!fromDomain) return "unknown";

  for (const entry of results) {
    if (entry.result !== "pass") continue;
    if (entry.method === "dmarc") return "pass";
    if (entry.method === "dkim") {
      const signer = entry.props["header.d"] ?? entry.props["header.i"];
      if (signer && domainsAligned(signer, fromDomain)) return "pass";
      continue;
    }
    const envelope = entry.props["smtp.mailfrom"] ?? entry.props["smtp.helo"];
    if (envelope && domainsAligned(envelope, fromDomain)) return "pass";
  }

  // Every verdict we could read was a verifier error → an infra state, same
  // posture as the rest of the SMS stack: not evidence of forgery.
  if (results.every((entry) => TRANSIENT_RESULTS.has(entry.result))) return "unknown";
  return "fail";
}

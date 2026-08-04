/**
 * `Authentication-Results` → verdict. Three-valued on purpose: a missing header
 * (the normal case on Resend inbound) is NOT evidence either way, so it must
 * never read as a pass — nor as a forgery, which would bounce every legitimate
 * emailed reply.
 */
import { describe, expect, it } from "vitest";
import {
  domainsAligned,
  evaluateAuthenticationResults,
  parseAuthenticationResults,
} from "@/lib/inbound-email/email-authentication";

const FROM = "manager@example.com";

describe("evaluateAuthenticationResults", () => {
  it("is unknown when there is no header to read", () => {
    expect(evaluateAuthenticationResults(undefined, FROM)).toBe("unknown");
    expect(evaluateAuthenticationResults("", FROM)).toBe("unknown");
    expect(evaluateAuthenticationResults("mx.proplane.test", FROM)).toBe("unknown");
  });

  it("passes on DMARC pass, including with a parenthesised policy comment", () => {
    expect(
      evaluateAuthenticationResults(
        "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=bounce@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
        FROM,
      ),
    ).toBe("pass");
  });

  it("passes on an aligned DKIM or SPF pass, including a subdomain signer", () => {
    expect(
      evaluateAuthenticationResults("mx.test; dkim=pass header.d=mail.example.com", FROM),
    ).toBe("pass");
    expect(
      evaluateAuthenticationResults("mx.test; spf=pass smtp.mailfrom=bounces@example.com", FROM),
    ).toBe("pass");
  });

  it("does NOT pass on an UNALIGNED pass — someone authenticated, just not as this manager", () => {
    expect(
      evaluateAuthenticationResults(
        "mx.test; spf=pass smtp.mailfrom=attacker@evil.test; dkim=pass header.d=evil.test",
        FROM,
      ),
    ).toBe("fail");
  });

  it("fails an explicit spoof verdict", () => {
    expect(
      evaluateAuthenticationResults("mx.test; spf=fail; dkim=none; dmarc=fail header.from=example.com", FROM),
    ).toBe("fail");
  });

  it("treats verifier errors as unknown, not forgery", () => {
    expect(evaluateAuthenticationResults("mx.test; spf=temperror; dkim=permerror", FROM)).toBe(
      "unknown",
    );
  });

  it("parses methods and their properties, ignoring comment text", () => {
    const parsed = parseAuthenticationResults(
      "mx.test; spf=pass (test.com: domain of x@example.com designates 1.2.3.4) smtp.mailfrom=x@example.com",
    );
    expect(parsed).toEqual([
      { method: "spf", result: "pass", props: { "smtp.mailfrom": "x@example.com" } },
    ]);
  });
});

describe("domainsAligned", () => {
  it("accepts identical and ancestor/descendant domains, rejects lookalikes", () => {
    expect(domainsAligned("example.com", "example.com")).toBe(true);
    expect(domainsAligned("@mail.example.com", "example.com")).toBe(true);
    expect(domainsAligned("x@example.com", "mail.example.com")).toBe(true);
    expect(domainsAligned("notexample.com", "example.com")).toBe(false);
    expect(domainsAligned("", "example.com")).toBe(false);
  });
});

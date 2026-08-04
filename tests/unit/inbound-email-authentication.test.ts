/**
 * `Authentication-Results` → assessment. The header set is the MESSAGE's own,
 * so a sender can write anything into it: these tests pin that a forged line
 * can never produce `authenticated` (the outcome that skips the single-use
 * grant), while an absent/unreadable header stays a neutral `unauthenticated`
 * with no verdict rather than reading as proof or as forgery.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assessInboundEmailAuthentication,
  domainsAligned,
  parseAuthenticationResults,
  parseAuthservId,
} from "@/lib/inbound-email/email-authentication";

const FROM = "manager@example.com";
const TRUSTED = { RESEND_AUTHSERV_ID: "mx.proplane.test" };

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe("assessInboundEmailAuthentication — a forged header cannot authorize", () => {
  it("does NOT authenticate a pass when no authserv-id is pinned (the default)", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; dmarc=pass header.from=example.com",
        FROM,
        {},
      ),
    ).toEqual({ outcome: "unauthenticated", verdictPresent: true });
  });

  it("does NOT authenticate a pass stamped by an unpinned authserv-id", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.attacker.test; dmarc=pass header.from=example.com",
        FROM,
        TRUSTED,
      ),
    ).toMatchObject({ outcome: "unauthenticated" });
  });

  it("reads ONLY the topmost header, so a line the sender wrote is unreachable", () => {
    // The receiver prepends its own A-R above the message's existing ones.
    expect(
      assessInboundEmailAuthentication(
        [
          "mx.proplane.test; spf=fail smtp.mailfrom=attacker@evil.test; dkim=fail",
          "mx.proplane.test; dmarc=pass header.from=example.com",
        ],
        FROM,
        TRUSTED,
      ),
    ).toEqual({ outcome: "reject" });
  });

  it("authenticates an aligned pass from a pinned receiver", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=bounce@example.com; dmarc=pass (p=REJECT) header.from=example.com",
        FROM,
        TRUSTED,
      ),
    ).toEqual({ outcome: "authenticated" });
  });

  it("accepts an aligned DKIM or SPF pass, including a subdomain signer", () => {
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; dkim=pass header.d=mail.example.com", FROM, TRUSTED),
    ).toMatchObject({ outcome: "authenticated" });
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; spf=pass smtp.mailfrom=bounces@example.com",
        FROM,
        TRUSTED,
      ),
    ).toMatchObject({ outcome: "authenticated" });
  });

  it("does not authenticate an UNALIGNED pass — someone authenticated, just not as this manager", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; spf=pass smtp.mailfrom=attacker@evil.test; dkim=pass header.d=evil.test",
        FROM,
        TRUSTED,
      ),
    ).toMatchObject({ outcome: "unauthenticated" });
  });

  it("reads the pinned list from RESEND_AUTHSERV_ID when no env is passed", () => {
    process.env.RESEND_AUTHSERV_ID = "other.test, mx.proplane.test";
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; dmarc=pass header.from=example.com", FROM),
    ).toMatchObject({ outcome: "authenticated" });
  });
});

describe("assessInboundEmailAuthentication — refusals and non-verdicts", () => {
  it("rejects an explicit aligned failure regardless of who stamped it", () => {
    expect(
      assessInboundEmailAuthentication("mx.whoever.test; dmarc=fail header.from=example.com", FROM, {}),
    ).toEqual({ outcome: "reject" });
    expect(
      assessInboundEmailAuthentication("mx.whoever.test; spf=fail; dkim=fail", FROM, {}),
    ).toMatchObject({ outcome: "reject" });
  });

  it("does not reject on SPF alone — forwarding breaks SPF for legitimate mail", () => {
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; spf=softfail; dkim=pass header.d=example.com", FROM, {}),
    ).toMatchObject({ outcome: "unauthenticated" });
  });

  it("reports NO verdict when there is nothing readable to judge", () => {
    const none = { outcome: "unauthenticated", verdictPresent: false };
    expect(assessInboundEmailAuthentication(undefined, FROM, TRUSTED)).toEqual(none);
    expect(assessInboundEmailAuthentication([], FROM, TRUSTED)).toEqual(none);
    expect(assessInboundEmailAuthentication("mx.proplane.test", FROM, TRUSTED)).toEqual(none);
    // A verifier that broke is an infra state, not evidence of forgery.
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; spf=temperror; dkim=permerror", FROM, TRUSTED),
    ).toEqual(none);
  });
});

describe("parsing helpers", () => {
  it("parses methods and their properties, ignoring comment text", () => {
    expect(
      parseAuthenticationResults(
        "mx.test; spf=pass (test.com: domain of x@example.com designates 1.2.3.4) smtp.mailfrom=x@example.com",
      ),
    ).toEqual([{ method: "spf", result: "pass", props: { "smtp.mailfrom": "x@example.com" } }]);
  });

  it("reads the authserv-id, and reports none when the header opens on a method", () => {
    expect(parseAuthservId("mx.proplane.test 1; dmarc=pass")).toBe("mx.proplane.test");
    expect(parseAuthservId("dmarc=pass header.from=example.com")).toBe("");
    expect(parseAuthservId("")).toBe("");
  });

  it("aligns identical and ancestor/descendant domains, rejects lookalikes", () => {
    expect(domainsAligned("example.com", "example.com")).toBe(true);
    expect(domainsAligned("@mail.example.com", "example.com")).toBe(true);
    expect(domainsAligned("x@example.com", "mail.example.com")).toBe(true);
    expect(domainsAligned("notexample.com", "example.com")).toBe(false);
    expect(domainsAligned("", "example.com")).toBe(false);
  });
});

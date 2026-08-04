/**
 * `Authentication-Results` → assessment. The header set is the MESSAGE's own,
 * so a sender can write anything into it: these tests pin that a forged line
 * can never produce `authenticated` (the outcome that skips the single-use
 * grant), while an absent/unreadable header stays a neutral `unauthenticated`
 * with no verdict rather than reading as proof or as forgery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessInboundEmailAuthentication,
  domainsAligned,
  parseAuthenticationResults,
  parseAuthservId,
} from "@/lib/inbound-email/email-authentication";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: () => ({}) }),
}));

import { fetchResendReceivedEmailBody } from "@/lib/inbound-email/inbound-email.server";

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
    ).toBe("unauthenticated");
  });

  it("does NOT authenticate a pass stamped by an unpinned authserv-id", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.attacker.test; dmarc=pass header.from=example.com",
        FROM,
        TRUSTED,
      ),
    ).toBe("unauthenticated");
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
    ).toBe("reject");
  });

  it("authenticates an aligned pass from a pinned receiver", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=bounce@example.com; dmarc=pass (p=REJECT) header.from=example.com",
        FROM,
        TRUSTED,
      ),
    ).toBe("authenticated");
  });

  it("accepts an aligned DKIM or SPF pass, including a subdomain signer", () => {
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; dkim=pass header.d=mail.example.com", FROM, TRUSTED),
    ).toBe("authenticated");
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; spf=pass smtp.mailfrom=bounces@example.com",
        FROM,
        TRUSTED,
      ),
    ).toBe("authenticated");
  });

  it("does not authenticate an UNALIGNED pass — someone authenticated, just not as this manager", () => {
    expect(
      assessInboundEmailAuthentication(
        "mx.proplane.test; spf=pass smtp.mailfrom=attacker@evil.test; dkim=pass header.d=evil.test",
        FROM,
        TRUSTED,
      ),
    ).toBe("unauthenticated");
  });

  it("reads the pinned list from RESEND_AUTHSERV_ID when no env is passed", () => {
    process.env.RESEND_AUTHSERV_ID = "other.test, mx.proplane.test";
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; dmarc=pass header.from=example.com", FROM),
    ).toBe("authenticated");
  });
});

describe("assessInboundEmailAuthentication — refusals and non-verdicts", () => {
  it("rejects an explicit aligned failure regardless of who stamped it", () => {
    expect(
      assessInboundEmailAuthentication("mx.whoever.test; dmarc=fail header.from=example.com", FROM, {}),
    ).toBe("reject");
    expect(
      assessInboundEmailAuthentication("mx.whoever.test; spf=fail; dkim=fail", FROM, {}),
    ).toBe("reject");
  });

  it("does not reject on SPF alone — forwarding breaks SPF for legitimate mail", () => {
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; spf=softfail; dkim=pass header.d=example.com", FROM, {}),
    ).toBe("unauthenticated");
  });

  it("reports NO verdict when there is nothing readable to judge", () => {
    expect(assessInboundEmailAuthentication(undefined, FROM, TRUSTED)).toBe("unauthenticated");
    expect(assessInboundEmailAuthentication([], FROM, TRUSTED)).toBe("unauthenticated");
    expect(assessInboundEmailAuthentication("mx.proplane.test", FROM, TRUSTED)).toBe("unauthenticated");
    // A verifier that broke is an infra state, not evidence of forgery.
    expect(
      assessInboundEmailAuthentication("mx.proplane.test; spf=temperror; dkim=permerror", FROM, TRUSTED),
    ).toBe("unauthenticated");
  });

  it("only ever REFUSES on an explicit aligned failure — everything else is neutral", () => {
    // `unauthenticated` is the default state, not an accusation: the caller
    // gates it on the reply grant, so a domain that publishes no policy (or a
    // deployment with no pinned receiver) can still reply by email.
    for (const header of [
      "mx.proplane.test; spf=none; dkim=none; dmarc=none header.from=example.com",
      "mx.proplane.test; dmarc=pass header.from=example.com",
      "mx.proplane.test; spf=neutral",
    ]) {
      expect(assessInboundEmailAuthentication(header, FROM, {})).toBe("unauthenticated");
    }
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

/**
 * A JSON OBJECT cannot carry two headers of the same name — `JSON.parse` keeps
 * the LAST, which for `Authentication-Results` is the SENDER's own bottom line,
 * not the receiver's topmost one. Trusting that survivor would let a forged
 * `<pinned-id>; dmarc=pass` reach `authenticated`, the one outcome that skips
 * the single-use grant.
 */
describe("received-email headers — an object shape can never grant a pass", () => {
  const ORIG_FETCH = globalThis.fetch;
  function stubFetch(headers: unknown) {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: { text: "hello", headers } }),
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
  });
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  it("drops a scalar object-form Authentication-Results instead of trusting it", async () => {
    stubFetch({ "Authentication-Results": "mx.proplane.test; dmarc=pass header.from=example.com" });
    const result = await fetchResendReceivedEmailBody("em_1");
    expect(result.kind).toBe("body");
    const headers = (result as { headers?: Record<string, string[]> }).headers ?? {};
    expect(headers["authentication-results"]).toBeUndefined();
    expect(assessInboundEmailAuthentication(headers["authentication-results"], FROM, TRUSTED)).toBe(
      "unauthenticated",
    );
  });

  it("keeps other object-form headers, and keeps an ARRAY of A-R values in order", async () => {
    stubFetch({
      Subject: "Re: text",
      "Authentication-Results": [
        "mx.proplane.test; spf=fail smtp.mailfrom=attacker@evil.test; dkim=fail",
        "mx.proplane.test; dmarc=pass header.from=example.com",
      ],
    });
    const result = await fetchResendReceivedEmailBody("em_2");
    const headers = (result as { headers?: Record<string, string[]> }).headers ?? {};
    expect(headers.subject).toEqual(["Re: text"]);
    expect(headers["authentication-results"]).toHaveLength(2);
    expect(assessInboundEmailAuthentication(headers["authentication-results"], FROM, TRUSTED)).toBe(
      "reject",
    );
  });

  it("still trusts the array-of-entries shape, which preserves received order", async () => {
    stubFetch([
      { name: "Authentication-Results", value: "mx.proplane.test; dmarc=pass header.from=example.com" },
      { name: "Authentication-Results", value: "mx.proplane.test; dmarc=fail header.from=example.com" },
    ]);
    const result = await fetchResendReceivedEmailBody("em_3");
    const headers = (result as { headers?: Record<string, string[]> }).headers ?? {};
    expect(assessInboundEmailAuthentication(headers["authentication-results"], FROM, TRUSTED)).toBe(
      "authenticated",
    );
  });
});

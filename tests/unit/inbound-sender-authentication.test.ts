import { describe, expect, it } from "vitest";
import { inboundSenderAuthenticated } from "@/lib/inbound-email/inbound-sender-authentication";

const ar = (value: string) => ({ "Authentication-Results": value });

describe("inboundSenderAuthenticated", () => {
  it("passes on an aligned dkim pass", () => {
    expect(
      inboundSenderAuthenticated(ar("mx.example.net; dkim=pass header.d=example.com header.s=s1"), "Renter@Example.com"),
    ).toBe(true);
  });

  it("passes on an aligned spf pass (subdomain mailfrom)", () => {
    expect(
      inboundSenderAuthenticated(ar("mx.example.net; spf=pass smtp.mailfrom=bounce.example.com"), "renter@example.com"),
    ).toBe(true);
  });

  it("accepts the [{name,value}] header shape", () => {
    expect(
      inboundSenderAuthenticated(
        [{ name: "authentication-results", value: "mx; dkim=pass header.d=example.com" }],
        "a@example.com",
      ),
    ).toBe(true);
  });

  it("fails closed with no headers, no header, or garbage", () => {
    expect(inboundSenderAuthenticated(undefined, "a@example.com")).toBe(false);
    expect(inboundSenderAuthenticated(null, "a@example.com")).toBe(false);
    expect(inboundSenderAuthenticated({ subject: "hi" }, "a@example.com")).toBe(false);
    expect(inboundSenderAuthenticated(ar("nonsense"), "a@example.com")).toBe(false);
    expect(inboundSenderAuthenticated(ar("mx; dkim=pass header.d=example.com"), "not-an-address")).toBe(false);
  });

  it("fails on fail, neutral, none and temperror results", () => {
    for (const result of ["fail", "neutral", "none", "temperror", "softfail"]) {
      expect(inboundSenderAuthenticated(ar(`mx; dkim=${result} header.d=example.com; spf=${result} smtp.mailfrom=example.com`), "a@example.com")).toBe(false);
    }
  });

  it("fails when the authenticated domain is not the From domain", () => {
    expect(inboundSenderAuthenticated(ar("mx; dkim=pass header.d=attacker.com; spf=pass smtp.mailfrom=attacker.com"), "victim@example.com")).toBe(false);
  });

  it("does not treat a bare TLD or a lookalike suffix as aligned", () => {
    expect(inboundSenderAuthenticated(ar("mx; dkim=pass header.d=com"), "a@example.com")).toBe(false);
    expect(inboundSenderAuthenticated(ar("mx; dkim=pass header.d=ample.com"), "a@example.com")).toBe(false);
  });

  it("reads only the topmost Authentication-Results header", () => {
    expect(
      inboundSenderAuthenticated(
        { "authentication-results": ["mx; dkim=fail header.d=example.com", "forged; dkim=pass header.d=example.com"] },
        "a@example.com",
      ),
    ).toBe(false);
  });
});

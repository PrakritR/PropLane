import { describe, expect, it } from "vitest";
import { canonicalizeLinkHost, formatSmsLinks, trimLinkTail } from "@/lib/sms/link-format";

const ORIGIN = "https://proplane.ai";

describe("formatSmsLinks", () => {
  it("puts a link that sat mid-sentence on its own line", () => {
    expect(formatSmsLinks("Here is your link: https://proplane.ai/l/abc We will text a code.", ORIGIN)).toBe(
      "Here is your link:\nhttps://proplane.ai/l/abc\nWe will text a code.",
    );
  });

  it("keeps sentence punctuation off the end of the address", () => {
    for (const glued of [".", ",", ")", "!", "?", ";", ":", ".)"]) {
      expect(formatSmsLinks(`Pay now https://proplane.ai/l/abc${glued}`, ORIGIN)).toBe("Pay now\nhttps://proplane.ai/l/abc");
    }
    expect(trimLinkTail("https://proplane.ai/l/abc).")).toEqual({ url: "https://proplane.ai/l/abc", tail: ")." });
  });

  it("rewrites our own non-canonical hosts to the canonical one and leaves others alone", () => {
    expect(canonicalizeLinkHost("https://proplane-abc123.vercel.app/l/tok?x=1", ORIGIN)).toBe("https://proplane.ai/l/tok?x=1");
    expect(canonicalizeLinkHost("https://www.proplane.ai/l/tok", ORIGIN)).toBe("https://proplane.ai/l/tok");
    expect(canonicalizeLinkHost("https://stripe.com/pay/x", ORIGIN)).toBe("https://stripe.com/pay/x");
    expect(canonicalizeLinkHost("http://localhost:3001/l/tok", ORIGIN)).toBe("http://localhost:3001/l/tok");
    expect(formatSmsLinks("Open https://proplane-git-x.vercel.app/l/tok.", ORIGIN)).toBe("Open\nhttps://proplane.ai/l/tok");
  });

  it("handles several links, one per line, and text with none", () => {
    expect(formatSmsLinks("Rent https://proplane.ai/l/a and lease https://proplane.ai/l/b.", ORIGIN)).toBe(
      "Rent\nhttps://proplane.ai/l/a\nand lease\nhttps://proplane.ai/l/b",
    );
    expect(formatSmsLinks("  Your rent is due.  ", ORIGIN)).toBe("Your rent is due.");
  });

  it("is idempotent", () => {
    const once = formatSmsLinks("Pay here: https://proplane.ai/l/abc.", ORIGIN);
    expect(formatSmsLinks(once, ORIGIN)).toBe(once);
  });
});

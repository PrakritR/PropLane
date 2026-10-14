import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET as getLlms } from "@/app/llms.txt/route";
import { GET as getLlmsFull } from "@/app/llms-full.txt/route";
import { BLOG_POSTS } from "@/lib/blog/posts";
import { llmsOrigin } from "@/lib/seo/llms";

const origin = llmsOrigin();

describe("/llms.txt", () => {
  it("is cached text/plain with the llmstxt.org shape", async () => {
    const res = getLlms();
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    const body = await res.text();
    expect(body.startsWith("# PropLane\n\n> ")).toBe(true);
    for (const h of ["## Docs", "## Product", "## Pricing", "## Blog", "## Optional"]) expect(body).toContain(h);
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaN");
  });

  it("links only absolute URLs under the canonical origin, including every post", async () => {
    const body = await getLlms().text();
    const urls = [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) expect(u.startsWith(`${origin}/`)).toBe(true);
    for (const p of BLOG_POSTS) expect(urls).toContain(`${origin}/blog/${p.slug}`);
    expect(urls).toContain(`${origin}/pricing`);
  });

  it("states plan prices from the rate card", async () => {
    const body = await getLlms().text();
    expect(body).toMatch(/Free for 2 residents/);
    expect(body).toMatch(/Pro at \$\d+\/month/);
  });
});

describe("/llms-full.txt", () => {
  it("carries every post as plain text with its source links", async () => {
    const res = getLlmsFull();
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).not.toContain("undefined");
    expect(body).not.toMatch(/\[[^\]]+\]\(\//);
    for (const p of BLOG_POSTS) {
      expect(body).toContain(p.title);
      expect(body).toContain(`${origin}/blog/${p.slug}`);
      for (const s of p.sources) expect(body).toContain(s.url);
    }
  });
});

describe("toPlainText", () => {
  it("leaves no angle bracket behind, terminated tag or not", async () => {
    const { toPlainText } = await import("@/lib/seo/llms");
    // An unterminated tag is exactly what a `<...>` tag regex leaves behind.
    expect(toPlainText("Rent <script src=x rose 4%")).toBe("Rent script src=x rose 4%");
    expect(toPlainText("**Bold** [label](https://x.test) <b>text</b>")).toBe("Bold label btext/b");
  });
});

describe("home page structured data", () => {
  it("embeds valid Organization + SoftwareApplication JSON-LD", async () => {
    const { homeJsonLd, jsonLdString } = await import("@/lib/seo/json-ld");
    const data = JSON.parse(jsonLdString(homeJsonLd("https://proplane.ai", "https://apps.apple.com/us/app/proplane/id1")));
    const types = data["@graph"].map((n: { "@type": string }) => n["@type"]);
    expect(types).toEqual(["Organization", "SoftwareApplication"]);
    expect(data["@graph"][1].offers.length).toBe(3);
    expect(data["@graph"][0].sameAs).toEqual(["https://apps.apple.com/us/app/proplane/id1"]);
    const src = readFileSync("src/app/(public)/page.tsx", "utf8");
    expect(src).toContain('type="application/ld+json"');
  });
});

describe("listing page structured data", () => {
  it("uses only projected public fields and parses as JSON", async () => {
    const { listingJsonLd, jsonLdString } = await import("@/lib/seo/json-ld");
    const property = {
      id: "p1", title: "Room near campus", tagline: "Quiet", address: "1 Main St", zip: "98105", neighborhood: "U District",
      beds: 3, baths: 2, rentLabel: "$1,200/mo", available: "Now", petFriendly: false, buildingId: "b", buildingName: "B", unitLabel: "1",
      contactSmsPhone: "+15551234567", contactWorkEmail: "m@example.com", managerUserId: "u-secret",
    };
    const text = jsonLdString(listingJsonLd(property as never, "https://proplane.ai"));
    const data = JSON.parse(text);
    expect(data["@type"]).toBe("Accommodation");
    expect(data.offers.price).toBe("1200");
    expect(data.offers.availability).toBe("https://schema.org/InStock");
    expect(data.address.postalCode).toBe("98105");
    expect(text).not.toMatch(/5551234567|example\.com|u-secret/);
    const src = readFileSync("src/app/(public)/rent/listings/[id]/page.tsx", "utf8");
    expect(src).toContain('type="application/ld+json"');
  });
});

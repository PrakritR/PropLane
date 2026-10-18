import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { MARKETING_REDIRECTS, PUBLIC_MARKETING_PATHS } from "@/lib/seo/marketing-routes";
import { buildLlmsTxt, buildLlmsFullTxt } from "@/lib/seo/llms";
import { homeJsonLd } from "@/lib/seo/json-ld";
import { MANAGED_SERVICE_HREF, MANAGED_CONTACT_HREF } from "@/lib/marketing/managed-service";
import sitemap from "@/app/sitemap";

vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: async () => [] }));
const targets = [
  ["/pricing", "/#pricing"], ["/pricing/service", "/#service"], ["/service", "/#service"],
  ["/why-proplane", "/#service"], ["/why-proplane/:path+", "/#service"],
  ["/contact", "/#contact"], ["/features", "/#dashboard"], ["/book-a-demo", "/#contact"],
  ["/support", "/#contact"], ["/reviews", "/"],
];

describe("single-page marketing routes", () => {
  it("registers exact 308 redirects without intermediate hops", async () => {
    const redirects = await nextConfig.redirects!();
    for (const [source, destination] of targets) {
      expect(redirects.filter((r) => r.source === source)).toEqual([{ source, destination, statusCode: 308 }]);
      const path = destination.split("#")[0];
      expect(existsSync(`src/app/(public)${path === "/" ? "" : path}/page.tsx`)).toBe(true);
      expect(redirects.some((r) => r.source === path)).toBe(false);
    }
  });

  it("points service and contact consumers directly to the home sections", () => {
    expect(MANAGED_SERVICE_HREF).toBe("/#service");
    expect(MANAGED_CONTACT_HREF).toBe("/#contact");
  });

  it("publishes only canonical page URLs in the sitemap", async () => {
    const urls = (await sitemap()).map((row) => row.url);
    for (const path of PUBLIC_MARKETING_PATHS) expect(urls).toContain(`https://proplane.ai${path || "/"}`);
    for (const { source } of MARKETING_REDIRECTS) expect(urls).not.toContain(`https://proplane.ai${source}`);
    expect(urls).toContain("https://proplane.ai/blog");
  });

  it("both llms surfaces link the home sections rather than retired routes", () => {
    for (const body of [buildLlmsTxt(), buildLlmsFullTxt()]) {
      for (const { source } of MARKETING_REDIRECTS) expect(body).not.toContain(`https://proplane.ai${source}`);
      for (const id of ["service", "pricing", "contact", "dashboard"]) expect(body).toContain(`/#${id}`);
    }
  });

  it("structured software offers use the same home pricing section", () => {
    const schema = homeJsonLd() as { "@graph": { "@type": string; offers?: { url: string }[] }[] };
    const software = schema["@graph"].find((row) => row["@type"] === "SoftwareApplication")!;
    expect(software.offers).toHaveLength(3);
    expect(software.offers!.every((offer) => offer.url === "https://proplane.ai/#pricing")).toBe(true);
    expect(schema["@graph"].some((row) => row["@type"] === "FAQPage")).toBe(false);
  });
});

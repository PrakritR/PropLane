import { describe, expect, it } from "vitest";
import { HOME_DESCRIPTION, HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { LLMS_SUMMARY } from "@/lib/seo/llms";
import { homeJsonLd } from "@/lib/seo/json-ld";

describe("homepage brand promise", () => {
  it("keeps the cover promise in search descriptions and structured data", () => {
    expect(HOME_HEADLINE).toBe("Your Housing Assistant");
    for (const copy of [
      HOME_DESCRIPTION,
      LLMS_SUMMARY,
      JSON.stringify(homeJsonLd()),
    ]) {
      expect(copy).toContain(HOME_HEADLINE);
      expect(copy).not.toContain("Your AI Property Manager");
    }
  });
});

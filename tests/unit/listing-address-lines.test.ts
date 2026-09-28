import { describe, expect, it } from "vitest";
import {
  listingSubmissionCityZipLine,
  listingSubmissionStreetLine,
} from "@/lib/manager-listing-submission";

const base = { city: "", state: "", neighborhood: "", zip: "", address: "" };
const joined = (sub: typeof base) =>
  [listingSubmissionStreetLine(sub), listingSubmissionCityZipLine(sub)].filter(Boolean).join(", ");

describe("listing address lines", () => {
  it("does not repeat the ZIP when only the ZIP is structured and the street carries it", () => {
    const sub = { ...base, address: "1200 Cascade Ave, Seattle, WA 98122", zip: "98122" };
    expect(joined(sub)).toBe("1200 Cascade Ave, Seattle, WA 98122");
  });

  it("strips the geocoded suffix when city and state are structured", () => {
    const sub = { ...base, address: "1200 Cascade Ave, Seattle, WA 98122", city: "Seattle", state: "wa", zip: "98122" };
    expect(listingSubmissionStreetLine(sub)).toBe("1200 Cascade Ave");
    expect(joined(sub)).toBe("1200 Cascade Ave, Seattle, WA 98122");
  });

  it("keeps a bare street plus a structured ZIP", () => {
    const sub = { ...base, address: "1200 Cascade Ave", zip: "98122" };
    expect(joined(sub)).toBe("1200 Cascade Ave, 98122");
  });
});

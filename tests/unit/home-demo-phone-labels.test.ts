import { describe, expect, it } from "vitest";
import { HOME_DEMO_JOURNEY } from "@/components/demo/home-demo-script";

describe("the homepage demo's phone captions (captain #30)", () => {
  it("name the role texting, never a person", () => {
    expect(HOME_DEMO_JOURNEY.phones.map((phone) => phone.label)).toEqual(["Resident’s phone", "Vendor’s phone"]);
    const name = HOME_DEMO_JOURNEY.resident.name.split(" ")[0]!;
    for (const phone of HOME_DEMO_JOURNEY.phones) expect(phone.label).not.toContain(name);
  });
});

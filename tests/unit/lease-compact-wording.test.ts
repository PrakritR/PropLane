import { describe, expect, it } from "vitest";
import { compactPremisesAccessParagraph } from "@/lib/lease-templates/build-compact-room-lease-html";
import { readFileSync } from "node:fs";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

describe("room lease wording", () => {
  it("says the floor once", () => {
    const text = compactPremisesAccessParagraph({ floor: "2nd floor" }, "", esc);
    expect(text).toContain("their room on the 2nd floor.");
    expect(text).not.toMatch(/floor floor/i);
    expect(compactPremisesAccessParagraph({ floor: "2nd" }, "", esc)).toContain("on the 2nd floor.");
    expect(compactPremisesAccessParagraph({ floor: "Main" }, "", esc)).toContain("on the Main floor.");
    expect(compactPremisesAccessParagraph(undefined, "", esc)).toContain("exclusive use of their private room.");
  });

  it("gives the bathroom arrangement its own sentence, with no stray comma or doubled period", () => {
    const text = compactPremisesAccessParagraph({ floor: "2nd floor" }, "shared with Room 2 (shared), Room 3.", esc);
    expect(text).toContain("Bathroom access: shared with Room 2 (shared), Room 3.");
    expect(text).not.toContain("Room 3.,");
    expect(text).not.toContain("..");
    expect(text).toContain("Resident shall also have shared, non-exclusive use of the kitchen");
    expect(compactPremisesAccessParagraph({}, "bath assigned to this room", esc)).toContain("only the bathroom assigned to their room.");
  });
});

describe("lease templates carry no handwritten signature lines", () => {
  it.each(["build-compact-room-lease-html.ts", "build-lease-html.ts"])("%s", (file) => {
    const source = readFileSync(`src/lib/lease-templates/${file}`, "utf8");
    expect(source).not.toContain("Landlord signature: ____");
    expect(source).not.toContain("Resident signature: ____");
  });

  it("the compact template completes the deposit-return sentence instead of printing a fragment", () => {
    const source = readFileSync("src/lib/lease-templates/build-compact-room-lease-html.ts", "utf8");
    expect(source).toContain("Landlord shall return any refundable portion of the deposit or provide a written itemized statement of deductions");
  });
});

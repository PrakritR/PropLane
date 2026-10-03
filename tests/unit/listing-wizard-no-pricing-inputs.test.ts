// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("listing wizard — no pricing inputs in room card (C2-RE15)", () => {
  it("ListingRoomEditorBody does not expose rent or Pricing rows", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/portal/listing-wizard-v2/listing-editor.tsx"),
      "utf8",
    );
    const start = src.indexOf("export function ListingRoomEditorBody(");
    const end = src.indexOf("function StepRooms(", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/Rent\s*\/\s*mo/i);
    expect(body).not.toMatch(/label="Pricing"/);
    expect(body).not.toMatch(/monthlyRent/);
  });
});

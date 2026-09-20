import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("listing normalize does not invent Shared areas", () => {
  it("folds leftover sharedSpacesDescription into houseDescription", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/manager-listing-submission.ts"), "utf8");
    expect(src).toContain("leftover free-text is house copy");
    expect(src).not.toContain('name: "Shared areas"');
    const editor = readFileSync(join(process.cwd(), "src/components/portal/listing-wizard-v2/listing-editor.tsx"), "utf8");
    expect(editor).not.toContain("listing-v2-add-details");
    expect(editor).toContain('summary="Advanced"');
  });
});

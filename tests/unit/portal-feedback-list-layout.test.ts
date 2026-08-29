import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/portal/portal-bug-feedback-panel.tsx"),
  "utf8",
);

describe("feedback list layout", () => {
  it("does not use a dashed list add row or desktop feedback table", () => {
    expect(source).not.toContain("<PortalListAddRow");
    expect(source).not.toContain("<table");
  });
});

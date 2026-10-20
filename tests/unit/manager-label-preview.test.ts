import { describe, expect, it } from "vitest";
import { managerLabelForPreview } from "@/lib/tools/manager-label";

describe("managerLabelForPreview", () => {
  it("shows a manager by name", () => {
    expect(managerLabelForPreview("Morgan Manager")).toBe("Morgan Manager");
  });

  it("never shows a login email, even as a nameless profile's fallback name", () => {
    expect(managerLabelForPreview("morgan@example.com")).toBe("your property manager");
  });
});

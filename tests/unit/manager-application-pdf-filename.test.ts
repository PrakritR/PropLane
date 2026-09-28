import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applicationPdfFilename } from "@/lib/manager-application-pdf-filename";

describe("applicationPdfFilename", () => {
  it("creates a stable filesystem-safe name without loading PDF tooling", () => {
    expect(applicationPdfFilename({ id: "AXIS 12/3", name: "  Jane O'Neil  " })).toBe(
      "jane-o-neil-axis-12-3.pdf",
    );
    expect(applicationPdfFilename({ id: "", name: "" })).toBe("application.pdf");
  });

  it("keeps the client applications panel off the pdf-lib implementation module", () => {
    const panel = readFileSync("src/components/portal/pro-applications.tsx", "utf8");
    expect(panel).toContain('from "@/lib/manager-application-pdf-filename"');
    expect(panel).not.toContain('from "@/lib/manager-application-pdf"');
  });
});

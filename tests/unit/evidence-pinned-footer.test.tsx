// @vitest-environment jsdom
/**
 * Render regression + evidence harness: dumps the pinned footer action dock
 * so the phone-width layout can be screenshotted in a real browser.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";

// Same convention as `evidence-manager-money-agreement.test.tsx`: the render is
// always exercised, the HTML is only written when EVIDENCE_DIR asks for it.
const OUT = process.env.EVIDENCE_DIR ?? "";

describe("evidence · pinned footer actions", () => {
  it("renders the header-variant dock", () => {
    const { container } = render(
      <PortalPageFooterActions pinned rowVariant="header">
        <button type="button" className="h-10 shrink-0 rounded-full border border-border bg-card px-4 text-sm font-semibold">
          Reminders
        </button>
        <button type="button" className="h-10 shrink-0 rounded-full border border-border bg-card px-4 text-sm font-semibold">
          Payment setup
        </button>
        <button type="button" className="h-10 shrink-0 rounded-full bg-primary px-4 text-sm font-semibold text-white">
          Add payment
        </button>
      </PortalPageFooterActions>,
    );

    expect(container.textContent).toContain("Add payment");

    if (!OUT) return;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      `${OUT}/pinned-footer.html`,
      `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="font:600 12px/1.4 system-ui;color:#64748b;margin:12px 16px">K · Pinned detail footer at phone width — actions sit left-aligned and the row scrolls horizontally instead of running off-screen.</p>
<div style="height:420px"></div>
${container.innerHTML}</body></html>`,
    );
  });
});

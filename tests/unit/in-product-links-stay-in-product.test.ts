/**
 * The shadowed marketing pages (/pricing, /support, /contact, …) are gone and their routes only 307 to a home
 * page anchor. Two classes of link had to move with them:
 *   - IN-PRODUCT links, which must not send a signed-in person out of the portal to the marketing site at all;
 *   - public-page links, which may reach the home anchors but must do it directly, with no redirect hop.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKETING_REDIRECTS } from "@/lib/seo/marketing-routes";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { MANAGED_CONTACT_HREF } from "@/lib/marketing/managed-service";

const read = (path: string) => readFileSync(path, "utf8");

/** Every path the config now redirects, as a quoted href literal a component could still carry. */
const RETIRED_HREFS = MARKETING_REDIRECTS.map(({ source }) => source).filter((source) => !source.includes(":"));

const PORTAL_SURFACES = [
  "src/components/portal/portal-help-panel.tsx",
  "src/components/portal/resident-payments-panel.tsx",
];

const PUBLIC_SURFACES = [
  "src/app/(public)/docs/page.tsx",
  "src/app/(public)/docs/mcp/page.tsx",
  "src/app/(public)/partner/page.tsx",
  "src/app/(public)/partner/contact/page.tsx",
  "src/app/(public)/vendors/page.tsx",
  "src/components/marketing/site/managed-service-sections.tsx",
];

describe("no surface links a retired marketing route", () => {
  it.each([...PORTAL_SURFACES, ...PUBLIC_SURFACES])("%s carries no retired href", (file) => {
    const source = read(file);
    for (const href of RETIRED_HREFS) {
      expect(source, `${file} should not link ${href}`).not.toContain(`"${href}"`);
    }
  });

  it("the portal Help panel keeps a signed-in person in the portal, on the support address", () => {
    const source = read("src/components/portal/portal-help-panel.tsx");
    expect(source).toContain("PUBLIC_SUPPORT_EMAIL");
    expect(source).toContain("mailto:${PUBLIC_SUPPORT_EMAIL}");
    expect(PUBLIC_SUPPORT_EMAIL).toBe("support@proplane.ai");
    // The feedback form is the other half of Help and stays inline.
    expect(source).toContain("PortalFeedbackFormBody");
  });

  it("the resident rent-reporting gate names who can act instead of linking a plan page", () => {
    // `upgradeRequired` reflects the MANAGER'S plan tier, so the resident never had anything to click.
    const source = read("src/components/portal/resident-payments-panel.tsx");
    expect(source).toContain("Ask your manager");
    expect(source).not.toMatch(/resident-rent-reporting-upgrade[\s\S]{0,200}href=/);
  });

  it("the public pages reach the home anchors directly", () => {
    expect(read("src/app/(public)/docs/page.tsx")).toContain('href="/#pricing"');
    expect(read("src/app/(public)/docs/page.tsx")).toContain('href="/#contact"');
    expect(read("src/app/(public)/docs/mcp/page.tsx")).toContain('href="/#contact"');
    expect(read("src/app/(public)/partner/page.tsx")).toContain('href="/#pricing"');
    expect(MANAGED_CONTACT_HREF).toBe("/#contact");
    expect(read("src/app/(public)/vendors/page.tsx")).toContain("secondaryHref={MANAGED_CONTACT_HREF}");
    expect(read("src/components/marketing/site/managed-service-sections.tsx")).toContain('software: "/#pricing"');
  });

  it("the partner contact page replaces itself with the home contact anchor, keeping the demo deep link", () => {
    const source = read("src/app/(public)/partner/contact/page.tsx");
    expect(source).toContain("router.replace(scheduleTab ? BOOK_DEMO_HREF : MANAGED_CONTACT_HREF)");
  });
});

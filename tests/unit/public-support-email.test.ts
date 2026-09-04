import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

const LEGACY_PUBLIC_SUPPORT_EMAIL = "info@axis-seattle-housing.com";

/**
 * Public support address surfaces. `PUBLIC_SUPPORT_EMAIL` drives footer /
 * contact / support; the legal + reviews pages hardcode the same address.
 */
const HARDCODED_PAGES = [
  "src/app/(public)/privacy/page.tsx",
  "src/app/(public)/tos/page.tsx",
  "src/app/(public)/sms-terms/page.tsx",
  "src/app/(public)/reviews/page.tsx",
];

function read(relPath: string) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

describe("public support email", () => {
  it("is the PropLane brand address", () => {
    expect(PUBLIC_SUPPORT_EMAIL).toBe("support@prop-lane.space");
  });

  it("no public page still shows the legacy info@ address", () => {
    for (const page of [...HARDCODED_PAGES, "src/lib/marketing/public-contact.ts"]) {
      expect(read(page), page).not.toContain(LEGACY_PUBLIC_SUPPORT_EMAIL);
    }
  });

  it("legal + reviews pages link and display the current support address", () => {
    for (const page of HARDCODED_PAGES) {
      const source = read(page);
      expect(source, page).toContain(`mailto:${PUBLIC_SUPPORT_EMAIL}`);
    }
  });

  it("keeps the reviews feedback mailto subject param", () => {
    expect(read("src/app/(public)/reviews/page.tsx")).toContain(
      `mailto:${PUBLIC_SUPPORT_EMAIL}?subject=PropLane%20feedback`,
    );
  });

  it("keeps the admin account identity separate from the public support address", () => {
    // The value itself is the captain's to choose (it moved to
    // prakritramachandran@gmail.com when that became the only admin). What must
    // hold is that the two are never the same address: support@ is published on
    // the marketing site, and `filterAdminUserIds` grants admin on a profile
    // email match, so collapsing them would hand admin to whoever writes in.
    expect(PRIMARY_ADMIN_EMAIL).not.toBe(PUBLIC_SUPPORT_EMAIL);
    expect(PRIMARY_ADMIN_EMAIL).toContain("@");
  });
});

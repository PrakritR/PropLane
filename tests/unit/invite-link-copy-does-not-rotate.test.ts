import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("invite link copy does not rotate", () => {
  const ROUTE = read("src/app/api/pro/invite-links/[linkId]/link/route.ts");
  const SERVER = read("src/lib/invite-links/invite-links.server.ts");
  const MODAL = read("src/components/portal/manager-invite-link-modal.tsx");

  it("reveals the same URL unless rotate is explicit", () => {
    expect(ROUTE).toContain("revealInviteLinkToken");
    expect(ROUTE).toContain("rotateInviteLinkToken");
    expect(ROUTE).toContain("body.rotate === true");
    expect(SERVER).toContain("token_ciphertext");
    expect(SERVER).toContain("revealInviteLinkToken");
  });

  it("labels Copy as copy, and Rotate as a separate action", () => {
    expect(MODAL).toContain('data-attr="invite-link-copy-existing"');
    expect(MODAL).toContain('data-attr="invite-link-rotate"');
    expect(MODAL).toContain("<span className=\"ml-1.5\">Copy</span>");
    expect(MODAL).not.toContain("Copy new link");
    expect(MODAL).toContain("revealInviteLinkClient(id, rotate)");
  });
});

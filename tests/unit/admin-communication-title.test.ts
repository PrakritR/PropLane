/**
 * C022: the Admin Communication page's on-page title still read "Inbox" after
 * the nav label and route were renamed to "Communication" — the one piece of
 * that item this wave could land without depending on the shared inbox
 * two-pane renderer (`pro-unified-inbox.tsx` / `portal-inbox-ui.tsx`), which
 * is out of scope this wave. See the wave report for why the two-pane rebuild
 * itself is blocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin Communication's on-page title matches its nav label", () => {
  const src = readFileSync(join(process.cwd(), "src/components/portal/admin-communication.tsx"), "utf8");

  it("no longer titles the page Inbox", () => {
    expect(src).toContain('title="Communication"');
    expect(src).not.toContain('title="Inbox"');
  });
});

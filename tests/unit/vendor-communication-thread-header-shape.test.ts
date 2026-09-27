import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C156: vendor Communication's embedded thread header (rendered only when
 * `suppressListPane` mounts inside `VendorUnifiedInbox`, the real
 * `/vendor/communication` route) used to reuse the legacy standalone
 * five-tab table's `renderExtraActions`, which offered a "Mark unread"
 * toggle nothing on the manager side has — manager's own thread header
 * (`pro-inbox.tsx`'s `threadHeaderActions`) is Archive + Delete on an active
 * thread, Restore + Delete on an archived one, with no mark-unread control
 * anywhere in the shared `CommunicationRowActions` either. The embedded
 * header now uses its own `renderEmbeddedThreadHeaderActions`, matching that
 * shape exactly; the legacy standalone table (/demo-only) keeps its own
 * Unopened/Opened-aware `renderExtraActions` unchanged.
 */
describe("vendor Communication embedded thread header matches the manager shape", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/portal/vendor-inbox-panel.tsx"),
    "utf8",
  );

  it("the embedded thread view uses the dedicated embedded header actions, not the legacy table's", () => {
    expect(source).toMatch(/headerActions=\{renderEmbeddedThreadHeaderActions\(/);
  });

  it("the embedded header actions never offer Mark unread", () => {
    const fnStart = source.indexOf("const renderEmbeddedThreadHeaderActions");
    const fnEnd = source.indexOf("const emptyCopy = inboxTabEmptyCopy(tabId);");
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnSource = source.slice(fnStart, fnEnd);
    expect(fnSource).not.toMatch(/Mark unread/);
    expect(fnSource).not.toMatch(/MailOpen/);
    // Matches the manager's own shape: Archive + Delete (active), Restore + Delete (trash).
    expect(fnSource).toMatch(/Archive conversation/);
    expect(fnSource).toMatch(/Delete conversation/);
    expect(fnSource).toMatch(/Restore conversation/);
  });
});

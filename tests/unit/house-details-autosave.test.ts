/**
 * AXI-164 — "no need to have save button at bottom should just auto save info".
 *
 * The House details tab (description / rules / general info) had a Save button
 * gated on a dirty flag. It now writes on a debounce, which makes two things
 * load-bearing that the button used to handle for free: telling the manager the
 * write happened, and not losing an edit made inside the debounce window.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  path.join(process.cwd(), "src/components/portal/manager-property-house-details-panel.tsx"),
  "utf8",
);

describe("house details autosave", () => {
  it("has no Save button any more", () => {
    expect(panel).not.toContain('data-attr="house-details-save"');
    expect(panel).not.toContain("<Button");
  });

  it("writes on a debounce rather than on a click", () => {
    expect(panel).toContain("HOUSE_DETAILS_AUTOSAVE_MS");
    expect(panel).toContain("setTimeout");
  });

  it("keeps the form dirty when a write fails", () => {
    // With no button, a failed autosave that cleared the flag would look
    // exactly like a successful one and the edit would be lost silently.
    const persist = panel.split("if (!ok) {")[1]?.slice(0, 400) ?? "";
    expect(persist).toContain('setStatus("error")');
    expect(persist).toContain("return;");
    expect(persist).not.toContain("setDirty(false)");
  });

  it("does not drop a keystroke that lands mid-save", () => {
    expect(panel).toContain("JSON.stringify(draftRef.current) === JSON.stringify(snapshot)");
  });

  it("flushes on unmount, so leaving the tab does not lose the last edit", () => {
    const unmount = panel.split("return () => {")[1]?.slice(0, 200) ?? "";
    expect(unmount).toContain("dirtyRef.current");
    expect(unmount).toContain("persistRef.current");
  });

  it("tells the manager what happened, since the button no longer does", () => {
    expect(panel).toContain('data-attr="house-details-autosave-status"');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain("Couldn't save");
  });
});

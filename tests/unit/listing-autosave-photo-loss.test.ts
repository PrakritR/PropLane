import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A manager uploads photos, the debounced autosave fires, the media upload
 * fails, and the photos vanish **from the form they are looking at** — while
 * the status pill reads "Saved to Drafts" (PRP-201).
 *
 * Two separate faults: `uploadSubmissionMedia` DROPS whatever failed, and its
 * result was written straight back into live form state; and the
 * `droppedAttachments` warning was surfaced only on the close path, i.e. never
 * on the path that runs most often.
 */
const FORM = readFileSync(
  join(process.cwd(), "src/components/portal/pro-add-listing-form.tsx"),
  "utf8",
);

function persistBody(): string {
  const start = FORM.indexOf("const uploaded = await uploadSubmissionMedia(current);");
  expect(start).toBeGreaterThan(-1);
  return FORM.slice(start, start + 1400);
}

describe("a failed background upload never deletes what the manager can see", () => {
  it("does not write the reduced submission into live state when anything failed", () => {
    const body = persistBody();
    const failedBranch = body.slice(body.indexOf("if (uploaded.failedCount > 0)"));
    // setSub must be in the ELSE, not before the branch.
    expect(failedBranch.slice(0, failedBranch.indexOf("} else {"))).not.toContain("setSub(");
    expect(failedBranch).toContain("} else {");
    expect(failedBranch.slice(failedBranch.indexOf("} else {"))).toContain("setSub(submission)");
  });

  it("still persists the reduced copy, so the draft is saved either way", () => {
    // The stripped/reduced submission is what goes to the server; only live
    // state is left alone.
    expect(persistBody()).toContain("submission = uploaded.submission;");
  });
});

describe("the manager is told, on every path", () => {
  it("warns on the silent autosave, not just on close", () => {
    expect(FORM).toContain(
      'showToast("Saved, but some photos couldn\'t be uploaded — they are still in the form, try again.")',
    );
  });

  it("the status pill does not claim a clean save", () => {
    expect(FORM).toContain('setAutosaveStatus(droppedAttachments ? "saved-without-photos" : "saved")');
    expect(FORM).toContain('"Saved to Drafts — photos not uploaded yet"');
  });

  it("that state clears on the next edit, like the ordinary saved state", () => {
    expect(FORM).toContain('status === "saved" || status === "saved-without-photos" ? "idle" : status');
  });
});

describe("the warning describes THIS attempt", () => {
  it("resets before each save, so a successful retry is not reported as lossy", () => {
    // A failed attachment now stays in the form, so a retry that uploads it
    // really does save it. Carrying the previous attempt's flag forward would
    // tell the manager to "add them again next time" about photos that are
    // stored — covered end-to-end by listing-wizard-draft-autosave.test.tsx.
    const body = FORM.slice(FORM.indexOf("let submission = current;"));
    expect(body.slice(0, 500)).toContain("droppedAttachmentsRef.current = false;");
    expect(body.indexOf("droppedAttachmentsRef.current = false;")).toBeLessThan(
      body.indexOf("uploadSubmissionMedia(current)"),
    );
  });
});

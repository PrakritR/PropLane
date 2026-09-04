import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Clicking Send on an incomplete compose form must keep the modal open AND say
 * why (PRP-227). The "keeps it open" half is structural — every validation
 * branch returns before the send — and the "says why" half used to be a toast
 * only: transient, bottom-corner, and easy to miss against a tall dialog, which
 * is how a click on Send could read as a silent no-op.
 *
 * Asserted against the source because the alternative is mounting the whole
 * compose modal with its directory, channel and schedule wiring, which tests
 * the harness more than the rule.
 */
const SOURCE = readFileSync(
  join(process.cwd(), "src/components/portal/pro-communication-compose-modal.tsx"),
  "utf8",
);

/** The body of `submit`, where the validation branches live. */
function submitBody(): string {
  const start = SOURCE.indexOf("const submit = async () => {");
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf("\n  const sendLabel", start));
}

describe("compose modal validation is visible, and never discards the draft", () => {
  it("renders the failure inside the modal, not only as a toast", () => {
    expect(SOURCE).toContain('data-attr="communication-compose-error"');
    expect(SOURCE).toContain('role="alert"');
  });

  it("every validation branch reports through `fail`, which sets that inline error", () => {
    const body = submitBody();
    // `fail` is the only way a validation branch may refuse: a bare showToast
    // would be invisible in the modal again.
    const bareToasts = body.match(/showToast\("(Write a message|Select at least one|Add a subject|Add at least one|Choose a valid|Send time must|Type an email)[^"]*"\)/g);
    expect(bareToasts).toBeNull();
    expect(body).toContain('fail("Write a message.");');
    expect(body).toContain('fail("Select at least one section under To.");');
    expect(body).toContain('fail("Add at least one email recipient (directory or Other).");');
  });

  it("`fail` both surfaces the inline error and keeps the toast", () => {
    expect(SOURCE).toContain("const fail = (message: string) => {");
    const fn = SOURCE.slice(SOURCE.indexOf("const fail = (message: string) => {"));
    expect(fn.slice(0, 160)).toContain("setFormError(message)");
    expect(fn.slice(0, 160)).toContain("showToast(message)");
  });

  it("no validation branch closes the modal — the draft always survives", () => {
    const body = submitBody();
    const failIndexes = [...body.matchAll(/fail\(/g)].map((m) => m.index ?? 0);
    expect(failIndexes.length).toBeGreaterThan(5);
    for (const index of failIndexes) {
      // The statement immediately after a refusal is a return, never onClose().
      const after = body.slice(index, index + 220);
      expect(after).toContain("return");
      expect(after.slice(0, after.indexOf("return"))).not.toContain("onClose");
    }
  });

  it("clears the previous failure when a new attempt starts", () => {
    expect(submitBody().slice(0, 120)).toContain("setFormError(null)");
  });
});

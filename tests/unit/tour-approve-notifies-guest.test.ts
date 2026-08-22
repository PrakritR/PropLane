// Every path that CONFIRMS a tour must tell the guest.
//
// `POST /api/portal-tour-inquiries/accept` reads `notifyTenant: body.notifyTenant === true`, so
// omitting the field means "do not email". There are two approve paths in the calendar panel:
//
//   - `submitTourGuestNotifyPreview` — the guest-notify preview; passed `notifyTenant`.
//   - `approveSelectedInquiry`       — the plain "Approve" button; passed NOTHING.
//
// So which control the manager happened to click decided whether the prospect was ever told
// their tour was confirmed. A confirmed tour the guest never hears about is the outcome that
// strands someone at a property — the same class of failure the delete-without-notice guard in
// `confirmed-tour-modal-actions` exists to prevent.
//
// Asserted against the source because the decision is a literal at the call site: there is no
// rendered state that distinguishes "emailed" from "silently confirmed".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANEL = readFileSync(
  join(process.cwd(), "src/components/portal/portal-calendar-panels.tsx"),
  "utf8",
);

/** Body of every `acceptPartnerInquiryFromServer(...)` call, brace-matched. */
function acceptCallBodies(src: string): string[] {
  const out: string[] = [];
  const needle = "acceptPartnerInquiryFromServer(";
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
    from = i + 1;
  }
  return out;
}

describe("confirming a tour always notifies the guest", () => {
  it("every accept call states notifyTenant explicitly", () => {
    const calls = acceptCallBodies(PANEL);
    // Guard against the sweep silently finding nothing if the helper is renamed.
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const silent = calls.filter((c) => !/notifyTenant\s*:/.test(c));
    expect(silent).toEqual([]);
  });

  it("no accept call hardcodes notifyTenant to false", () => {
    // `!skipMessage` is fine — the manager chose. A literal `false` is not.
    for (const call of acceptCallBodies(PANEL)) {
      expect(call).not.toMatch(/notifyTenant\s*:\s*false/);
    }
  });

  it("the route still defaults to NOT notifying, which is why the call sites must be explicit", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/portal-tour-inquiries/accept/route.ts"),
      "utf8",
    );
    // If this ever flips to a permissive default, the guard above stops being load-bearing.
    expect(route).toMatch(/notifyTenant:\s*body\.notifyTenant === true/);
  });
});

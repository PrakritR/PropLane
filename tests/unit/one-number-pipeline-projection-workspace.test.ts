// On the shared line there is no work-number row to place a thread by: the projection needs the router's
// workspace on EVERY classified inbound. Five calls (prospect, resident, vendor x2, paused) left it out, so the
// text never reached the team's inbox and the durable prospect burst failed with "envelopes unavailable"
// (found by the end-to-end harness). A source guard, because the helper is private to the pipeline.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/sms/inbound-pipeline.server.ts", "utf8");

function calls(): string[] {
  const out: string[] = [];
  const pattern = "projectClassifiedInbound(db, {";
  let from = 0;
  for (;;) {
    const at = source.indexOf(pattern, from);
    if (at < 0) return out;
    let depth = 1;
    let cursor = at + pattern.length;
    while (depth > 0 && cursor < source.length) {
      const ch = source[cursor++];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    out.push(source.slice(at, cursor));
    from = cursor;
  }
}

describe("classified inbound projection carries the workspace", () => {
  it("finds the calls", () => expect(calls().length).toBeGreaterThanOrEqual(7));
  it("every call passes workspaceId", () => {
    const missing = calls().filter((call) => !/workspaceId/.test(call)).map((call) => call.slice(0, 120));
    expect(missing).toEqual([]);
  });
});

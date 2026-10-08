// Communication picks its columns from the width of its own surface, never the viewport.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pickInboxColumns } from "@/lib/inbox-columns";

describe("pickInboxColumns", () => {
  it("draws three columns from 1040px up", () => {
    expect(pickInboxColumns(1040)).toBe(3);
    expect(pickInboxColumns(1512)).toBe(3);
  });
  it("drops the details column at 1039px", () => {
    expect(pickInboxColumns(1039)).toBe(2);
    expect(pickInboxColumns(760)).toBe(2);
  });
  it("shows the thread alone under 760px", () => {
    expect(pickInboxColumns(759)).toBe(1);
    expect(pickInboxColumns(390)).toBe(1);
  });
});

describe("InboxTwoPane source guard", () => {
  const src = readFileSync(join(process.cwd(), "src/components/portal/portal-inbox-ui.tsx"), "utf8");
  const start = src.indexOf("export function InboxTwoPane(");
  const body = src.slice(start);

  it("no longer reads the viewport width for its columns", () => {
    expect(src).not.toMatch(/useMinWidth\(/);
    expect(body).not.toMatch(/xl:grid-cols-\[320px/);
    expect(body).not.toMatch(/matchMedia/);
  });
  it("measures its own width and picks the columns from it", () => {
    expect(body).toContain("pickInboxColumns(");
    expect(body).toContain("new ResizeObserver(");
  });
});

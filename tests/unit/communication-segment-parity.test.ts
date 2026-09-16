import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
describe("Communication status and action parity", () => {
  it.each(["pro-unified-inbox", "resident-communication", "vendor-communication"])("%s uses row actions without rails or bulk bars", (name) => {
    const source = read(`src/components/portal/${name}.tsx`);
    expect(source).not.toContain("<InboxListSegmentRail");
    expect(source).not.toContain("<CommunicationListBulkBar");
    expect(source).toContain("<CommunicationRowActions row={row}");
  });
  it("shares status choices across manager, resident and vendor", () => {
    const fields = read("src/components/portal/communication-status-filter.tsx");
    for (const label of ["All conversations", "Read", "Unread", "Archived"]) expect(fields).toContain(`label: "${label}"`);
    expect(read("src/components/portal/communication-filter-sort-fields.tsx")).toContain("<CommunicationStatusFilter");
    expect(read("src/components/portal/communication-filter-sort-fields.tsx")).toContain("hideArchived");
    expect(read("src/components/portal/pro-communication.tsx")).toContain("hideArchived");
    for (const role of ["resident", "vendor"]) expect(read(`src/components/portal/${role}-communication.tsx`)).toContain("<CommunicationStatusFilterDraft");
  });
});

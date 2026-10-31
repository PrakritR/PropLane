import { expect, it } from "vitest";
import * as links from "@/lib/tour-resident-link.server";
it("does not expose bulk inbox adoption by email", () => {
  expect(links).not.toHaveProperty("attachInboxThreadsToResident");
});

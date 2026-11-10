// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResidentLifecycleStatusPanel } from "@/components/portal/resident-lifecycle-status-panel";
import type { ResidentLifecycleInput } from "@/lib/resident-lifecycle-journey";

const submitted: ResidentLifecycleInput = { applicationSubmitted: true, applicationFeePaid: true, applicationApproved: false, residentSignedLease: false, managerCountersigned: false, moveInChargesPaid: false, movedIn: false };
afterEach(cleanup);

it("retargets the existing under-review action without duplicating it", () => {
  render(<ResidentLifecycleStatusPanel input={submitted} detailHref="/resident/applications/pending/OWN%20ID" />);
  const links = screen.getAllByRole("link", { name: "View application" });
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute("href", "/resident/applications/pending/OWN%20ID");
});

it("preserves the fee action and offers the detail separately", () => {
  render(<ResidentLifecycleStatusPanel input={{ ...submitted, applicationFeePaid: false }} detailHref="/resident/applications/pending/OWN" />);
  expect(screen.getByRole("link", { name: "Message manager" })).toHaveAttribute("href", "/resident/communication");
  expect(screen.getByRole("link", { name: "View application" })).toHaveAttribute("href", "/resident/applications/pending/OWN");
});

it("adds no detail action when rendered inside the detail page", () => {
  render(<ResidentLifecycleStatusPanel input={{ ...submitted, applicationFeePaid: false }} />);
  expect(screen.queryByRole("link", { name: "View application" })).toBeNull();
});

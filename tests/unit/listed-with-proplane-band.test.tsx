// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ListedWithProPlaneBand } from "@/components/marketing/listed-with-proplane-band";
import { MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";

afterEach(cleanup);

describe("Listed with PropLane band", () => {
  it("sends 'Free for landlords' to the manager sign-up, not the partner page", () => {
    render(<ListedWithProPlaneBand propertyId="mgr-test-alder" />);
    const link = document.querySelector('[data-attr="listed-with-proplane-cta"]');
    expect(link?.textContent).toContain("Free for landlords");
    expect(link?.getAttribute("href")).toBe(MANAGER_GET_STARTED_HREF);
    expect(MANAGER_GET_STARTED_HREF).toBe("/auth/create-account?mode=create&role=manager");
  });
});

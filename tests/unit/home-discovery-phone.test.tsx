// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomeDiscoveryPhone } from "@/components/marketing/home-discovery-phone";
import { DISCOVERY_LINES, DISCOVERY_LISTINGS } from "@/components/marketing/home-discovery-script";

afterEach(cleanup);

describe("hero discovery phone", () => {
  it("renders the shared script in order, listings as no-photo cards, with no copy of its own", async () => {
    const { container } = render(<HomeDiscoveryPhone />);
    await waitFor(() => expect(container.querySelectorAll(".home-discovery-listing")).toHaveLength(DISCOVERY_LISTINGS.length));
    for (const line of DISCOVERY_LINES) {
      if (line.kind === "prospect" || line.kind === "proplane" || line.kind === "divider") expect(screen.getByText(line.text)).toBeInTheDocument();
    }
    for (const listing of DISCOVERY_LISTINGS) {
      expect(screen.getByText(listing.title)).toBeInTheDocument();
      expect(screen.getByText(listing.rentLabel)).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".home-discovery-listing")).toHaveLength(DISCOVERY_LISTINGS.length);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".home-iphone-card")).toHaveTextContent("TOUR · 61 WILLOW COURT");
  });
});

// @vitest-environment jsdom
//
// PRP-429 sibling: the dashboard "Your properties" card reads the same local
// store the Properties list does, so the same slow-`/api/property-records`
// window used to render "No properties yet" for a real portfolio. This
// isolates the pure presentational fix on `PortfolioPropertiesSection` itself.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortfolioPropertiesSection, type PortfolioPropertyCardData } from "@/components/portal/pro-dashboard-portfolio";

afterEach(cleanup);

const CARD: PortfolioPropertyCardData = {
  key: "mgr-dash-house-1",
  stage: "listed",
  title: "Test Dashboard House",
  address: "1 Dashboard Way",
  spacesLabel: "1 space",
  spaces: 1,
  rentLabel: "$1,000/mo",
  coverUrl: null,
};

describe("PortfolioPropertiesSection loading state", () => {
  it("shows the loading treatment while cards have not synced yet, never the empty copy", () => {
    render(<PortfolioPropertiesSection cards={[]} basePath="/portal" loading />);
    expect(screen.getByRole("status", { name: "Loading properties" })).toBeInTheDocument();
    expect(screen.queryByText("No properties yet. Add your first home to start leasing.")).not.toBeInTheDocument();
  });

  it("shows the real empty state once loading is done and there are truly no cards", () => {
    render(<PortfolioPropertiesSection cards={[]} basePath="/portal" loading={false} />);
    expect(screen.getByText("No properties yet. Add your first home to start leasing.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading properties" })).not.toBeInTheDocument();
  });

  it("shows the cards once they have loaded", () => {
    render(<PortfolioPropertiesSection cards={[CARD]} basePath="/portal" loading={false} />);
    expect(screen.getByText("Test Dashboard House")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading properties" })).not.toBeInTheDocument();
    expect(screen.queryByText("No properties yet. Add your first home to start leasing.")).not.toBeInTheDocument();
  });
});

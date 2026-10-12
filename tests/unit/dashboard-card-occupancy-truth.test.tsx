// @vitest-environment jsdom
/**
 * The dashboard property card says what the occupancy snapshot says: rooms occupied today, from the
 * same rule every other surface reads. Until that answers (or when it fails) the card is unknown,
 * never a confident "0 / 9 occupied".
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortfolioPropertyCard, type PortfolioPropertyCardData } from "@/components/portal/pro-dashboard-portfolio";

const card: PortfolioPropertyCardData = {
  key: "home-1",
  stage: "listed",
  title: "5257 Brooklyn Ave",
  address: "Seattle, WA",
  spacesLabel: "9 spaces",
  spaces: 9,
  rentLabel: "$1,050-$1,200/mo",
  coverUrl: null,
};

afterEach(cleanup);

describe("PortfolioPropertyCard occupancy", () => {
  it("shows the occupied rooms the snapshot counted", () => {
    render(<PortfolioPropertyCard card={card} basePath="/manager" occupied={8} />);
    expect(screen.getByRole("img", { name: "8 of 9 spaces occupied" })).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
  });

  it("an unanswered read is not zero: a placeholder figure and a loading bar", () => {
    render(<PortfolioPropertyCard card={card} basePath="/manager" occupied={null} occupancyLoading />);
    expect(screen.getByRole("img", { name: "Loading occupancy" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("a failed read says unavailable, not zero", () => {
    render(<PortfolioPropertyCard card={card} basePath="/manager" occupied={null} />);
    expect(screen.getByRole("img", { name: "Occupancy unavailable" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("a genuinely empty house still reads 0 once the snapshot says so", () => {
    render(<PortfolioPropertyCard card={card} basePath="/manager" occupied={0} />);
    expect(screen.getByRole("img", { name: "0 of 9 spaces occupied" })).toBeTruthy();
  });
});

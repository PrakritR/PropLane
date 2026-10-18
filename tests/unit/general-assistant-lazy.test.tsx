// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralAssistantLazy } from "@/components/general/general-assistant-lazy";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("next/dynamic", () => ({ default: () => function Assistant() { return <aside aria-label="General assistant" />; } }));
afterEach(cleanup);

describe("public assistant route boundary", () => {
  it("leaves the homepage to its own demo and restores the assistant on other public routes", () => {
    route.pathname = "/";
    const view = render(<GeneralAssistantLazy />);
    expect(screen.queryByRole("complementary", { name: "General assistant" })).not.toBeInTheDocument();
    route.pathname = "/features";
    view.rerender(<GeneralAssistantLazy />);
    expect(screen.getByRole("complementary", { name: "General assistant" })).toBeInTheDocument();
    route.pathname = "/";
    view.rerender(<GeneralAssistantLazy />);
    expect(screen.queryByRole("complementary", { name: "General assistant" })).not.toBeInTheDocument();
  });
});

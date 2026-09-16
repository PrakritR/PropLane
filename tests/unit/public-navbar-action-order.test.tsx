// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Navbar1 } from "@/components/ui/navbar1";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const auth = {
  login: { text: "Log in", url: "/auth/sign-in" },
  signup: { text: "Start free", url: "/auth/create-account" },
  secondary: { text: "Book a demo", url: "/contact", dataAttr: "nav-book-demo" },
};

function authHrefs(root: ParentNode) {
  return [...root.querySelectorAll("a")]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string =>
      href === "/contact" || href === "/auth/create-account" || href === "/auth/sign-in",
    );
}

describe("public navbar signed-out action order", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts Log in last on desktop: Book a demo, Start free, then Log in", () => {
    const { container } = render(<Navbar1 logoSlot={<span>Logo</span>} menu={[]} auth={auth} />);
    const desktopNav = container.querySelector("nav");
    expect(desktopNav).toBeTruthy();
    expect(authHrefs(desktopNav!)).toEqual(["/contact", "/auth/create-account", "/auth/sign-in"]);
  });

  it("puts Log in last on the phone sheet: Start free, then Log in", async () => {
    render(<Navbar1 logoSlot={<span>Logo</span>} menu={[]} auth={auth} />);
    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    const sheet = await screen.findByRole("dialog");
    expect(authHrefs(sheet)).toEqual(["/auth/create-account", "/auth/sign-in"]);
    expect(within(sheet).queryByRole("link", { name: /book a demo/i })).toBeNull();
  });

  it("keeps a single Portal control when signed in", () => {
    render(
      <Navbar1
        logoSlot={<span>Logo</span>}
        menu={[]}
        auth={auth}
        portalLink={{ text: "Portal", url: "/portal/dashboard" }}
      />,
    );

    expect(screen.getAllByRole("link", { name: /^portal$/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /log in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /start free/i })).toBeNull();
  });
});

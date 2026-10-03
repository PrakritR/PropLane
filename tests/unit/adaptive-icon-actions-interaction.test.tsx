// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { portalIconActionSpec } from "@/components/portal/portal-icon-action-spec";

afterEach(cleanup);

describe("adaptive header icon handlers", () => {
  it("keeps the primary accessible while overflow invokes the same action and closes", async () => {
    const edit = vi.fn();
    const approve = vi.fn();
    const remove = vi.fn();
    render(<PortalAdaptiveActionRow maxVisible={1} actions={[
      portalIconActionSpec({ id: "approve", label: "Approve", icon: Check, tone: "primary", onClick: approve }),
      portalIconActionSpec({ id: "edit", label: "Edit", icon: Pencil, onClick: edit }),
      portalIconActionSpec({ id: "delete", label: "Delete", icon: Trash2, tone: "danger", disabled: true, onClick: remove }),
    ]} />);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["More actions", "Approve"]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

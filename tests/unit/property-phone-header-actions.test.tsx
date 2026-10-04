// @vitest-environment jsdom
/**
 * A property's header on a phone is Edit plus one ⋯ (Share, Unlist, Duplicate,
 * Delete; Email on the preview), so the title keeps one line. Wider widths keep
 * every icon. The phone renders this OR the adaptive row, never both.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Pencil, Share2 } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PropertyPhoneHeaderActions } from "@/components/portal/property-phone-header-actions";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { splitPropertyPhoneHeaderActions } from "@/lib/property-phone-header-actions";
import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";

afterEach(cleanup);

function action(id: string, label: string): PortalAdaptiveAction {
  return {
    id,
    node: <PortalIconAction ring icon={id === "edit-listing" ? Pencil : Share2} label={label} data-attr={`a-${id}`} />,
    menuItem: <DropdownMenuItem data-attr={`m-${id}`}>{label}</DropdownMenuItem>,
  };
}

const LISTED = [
  action("edit-listing", "Edit"),
  action("send-listing", "Share"),
  action("unlist", "Unlist"),
  action("duplicate-listing", "Duplicate property"),
  action("delete-listed", "Delete"),
];

describe("splitPropertyPhoneHeaderActions", () => {
  it("keeps Edit and folds Share, Unlist, Duplicate, Delete into the menu in order", () => {
    const { primary, menu } = splitPropertyPhoneHeaderActions(LISTED);
    expect(primary?.id).toBe("edit-listing");
    expect(menu.map((a) => a.id)).toEqual(["send-listing", "unlist", "duplicate-listing", "delete-listed"]);
  });

  it("treats a draft's Edit as the primary too", () => {
    const draft = [action("continue-draft", "Edit"), action("duplicate-listing", "Duplicate"), action("delete-draft", "Delete")];
    const { primary, menu } = splitPropertyPhoneHeaderActions(draft);
    expect(primary?.id).toBe("continue-draft");
    expect(menu.map((a) => a.id)).toEqual(["duplicate-listing", "delete-draft"]);
  });

  it("slips the phone-only Email in after Share", () => {
    const { menu } = splitPropertyPhoneHeaderActions(LISTED, action("email-manager", "Email"));
    expect(menu.map((a) => a.id)).toEqual(["send-listing", "email-manager", "unlist", "duplicate-listing", "delete-listed"]);
  });

  it("has no primary when the viewer cannot edit — only the menu", () => {
    const { primary, menu } = splitPropertyPhoneHeaderActions(LISTED.slice(1));
    expect(primary).toBeNull();
    expect(menu).toHaveLength(4);
  });
});

describe("PropertyPhoneHeaderActions", () => {
  it("renders exactly two round controls: Edit and one More actions menu", () => {
    render(<PropertyPhoneHeaderActions actions={LISTED} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Edit", "More actions"]);
    // none of the folded icons is drawn beside Edit
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("property header — phone wiring (source)", () => {
  const panel = readFileSync(resolve(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx"), "utf8");
  const memo = panel.slice(
    panel.indexOf("const propertyTabFooterActions = useMemo"),
    panel.indexOf("const hasPinnedPropertyFooter"),
  );

  it("renders the phone header below md and the adaptive row at md and up, never both", () => {
    expect(memo).toContain("!mdUp && (bucket === 2 || bucket === 5)");
    expect(memo).toContain("<PropertyPhoneHeaderActions");
    expect(memo).toContain("<PortalAdaptiveActionRow");
    expect(memo.indexOf("<PropertyPhoneHeaderActions")).toBeLessThan(memo.indexOf("<PortalAdaptiveActionRow"));
  });

  it("keeps the name on one line on a phone and offers Email only through the menu", () => {
    expect(panel).toContain("titleSingleLine={sourceBucket !== 3}");
    expect(memo).toContain('id: "email-manager"');
  });

  it("shows the sections as phone underline tabs, not the Section picker sheet", () => {
    expect(panel).toMatch(/ariaLabel="Property sections"\s+phoneTabs/);
  });
});

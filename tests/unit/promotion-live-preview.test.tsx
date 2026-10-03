// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromotionUploadPreview, PromotionPostPreview } from "@/components/portal/promotion-live-preview";
import { PromotionNewModal } from "@/components/portal/promotion-new-modal";
import { EMPTY_DRAFT } from "@/components/portal/promotion-form";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("renders current facts and selected photos as a post", () => {
  const { rerender } = render(<PromotionPostPreview draft={{ ...EMPTY_DRAFT, headline: "Garden apartment", price: "$2,100", propertyLabel: "Cedar House" }} options={{ format: "listing_blurb", tone: "Professional", images: ["data:image/png;base64,AA"], extraInstructions: "" }} />);
  expect(screen.getByText(/Garden apartment/)).toBeTruthy();
  expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AA");
  rerender(<PromotionPostPreview draft={{ ...EMPTY_DRAFT, headline: "Updated apartment", propertyLabel: "Cedar House" }} options={{ format: "sms", tone: "Professional", images: [], extraInstructions: "" }} />);
  expect(screen.getByText(/Updated apartment/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("previews local uploads and releases replaced and unmounted URLs", () => {
  const create = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const { rerender, unmount } = render(<PromotionUploadPreview file={new File(["image"], "house.png", { type: "image/png" })} />);
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:first");
  rerender(<PromotionUploadPreview file={new File(["pdf"], "flyer.pdf", { type: "application/pdf" })} />);
  expect(revoke).toHaveBeenCalledWith("blob:first");
  expect(screen.getByLabelText("Preview flyer.pdf").getAttribute("data")).toBe("blob:second");
  unmount();
  expect(revoke).toHaveBeenCalledWith("blob:second");
  vi.unstubAllGlobals();
});

describe("promotion step continuity", () => {
  it("keeps text inputs and the generate handler alive on the Preview step", () => {
    const generate = vi.fn();
    render(<AppUiProvider><PromotionNewModal open initialKind="text" initialStepId="content" onClose={() => {}} draft={{ ...EMPTY_DRAFT, propertyLabel: "Cedar House", headline: "Garden apartment" }} setDraft={() => {}} listings={[]} onSelectProperty={() => {}} onGenerateFlyer={() => {}} onGenerateText={generate} /></AppUiProvider>);
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: "Keep the garden as the opening fact" } });
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-preview"]')!);
    fireEvent.click(document.querySelector('[data-attr="promotion-text-generate-submit"]')!);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ extraInstructions: "Keep the garden as the opening fact" }));
  });
});

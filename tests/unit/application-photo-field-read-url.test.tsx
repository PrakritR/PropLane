// @vitest-environment jsdom
//
// The application id is resolved through the wizard's `ensureApplicationId`, which
// MINTS an id and sets state on the wizard. Calling it while `ApplicationPhotoField`
// renders produced React's "Cannot update a component while rendering a different
// component" — observed in the browser against this exact component. It is resolved
// in an effect instead, which means the read URL is empty on first paint; these tests
// pin both halves of that, because the naive fix (render `src=""` until it arrives)
// latches the image-load failure and strands a real attachment on the text chip.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ApplicationPhotoField } from "@/components/marketing/application-photo-field";
import type { ApplicationPhotoAttachment } from "@/lib/rental-application/types";

const attachment: ApplicationPhotoAttachment = {
  storagePath: "application/abc/custom-1-2.png.penc",
  fileName: "proof.png",
  mimeType: "image/png",
  sizeBytes: 128,
  uploadedAt: new Date().toISOString(),
};

function renderField(getApplicationId: () => string) {
  return render(
    <ApplicationPhotoField
      slot="custom"
      fieldKey="proof-of-income"
      label="Upload proof of income"
      attachment={attachment}
      onChange={() => {}}
      getApplicationId={getApplicationId}
      readOnly
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ApplicationPhotoField read URL resolution", () => {
  it("does not set state on the parent while rendering (the observed React error)", async () => {
    // Reproduces the real shape: the wizard passes `ensureApplicationId`, which
    // mints an id AND sets wizard state. If this component calls it during its
    // own render, React logs "Cannot update a component (`Parent`) while
    // rendering a different component (`ApplicationPhotoField`)" — exactly what
    // was seen in the browser. Spy on console.error and assert it never appears.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function Parent() {
      const [mintedId, setMintedId] = useState("");
      const ensureApplicationId = () => {
        setMintedId("PROPLANE-E7AC04DD");
        return "PROPLANE-E7AC04DD";
      };
      return (
        <>
          <span data-testid="minted">{mintedId}</span>
          <ApplicationPhotoField
            slot="custom"
            fieldKey="proof-of-income"
            label="Upload proof of income"
            attachment={attachment}
            onChange={() => {}}
            getApplicationId={ensureApplicationId}
            readOnly
          />
        </>
      );
    }

    render(<Parent />);
    await waitFor(() => {
      expect(document.querySelector("img")).not.toBeNull();
    });

    const offending = errorSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((text) => text.includes("while rendering a different component"));
    expect(offending).toEqual([]);
  });

  it("resolves the read URL after commit, carrying slot and question key", async () => {
    renderField(() => "PROPLANE-E7AC04DD");
    await waitFor(() => {
      const img = document.querySelector("img");
      expect(img).not.toBeNull();
      const src = img!.getAttribute("src") ?? "";
      expect(src).toContain("applicationId=PROPLANE-E7AC04DD");
      expect(src).toContain("slot=custom");
      expect(src).toContain("key=proof-of-income");
    });
  });

  it("does not render an image with an empty src while the id is still resolving", () => {
    // An <img src=""> requests the current page, gets HTML back, fires onError and
    // latches the failure — so a real attachment would never show its thumbnail.
    renderField(() => "PROPLANE-E7AC04DD");
    for (const img of Array.from(document.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).not.toBe("");
    }
  });
});

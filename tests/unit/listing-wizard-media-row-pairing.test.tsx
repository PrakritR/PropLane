// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ListingMediaRow } from "@/components/portal/listing-room-editor/listing-media-row";

describe("listing wizard media row pairing (C2-RE9)", () => {
  it("renders Photos and Video in one data-re30-media row", () => {
    const { container } = render(
      <ListingMediaRow photos={<span data-testid="photos">p</span>} video={<span data-testid="video">v</span>} />,
    );
    const row = container.querySelector('[data-attr="re30-media"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-testid="photos"]')).not.toBeNull();
    expect(row?.querySelector('[data-testid="video"]')).not.toBeNull();
  });
});

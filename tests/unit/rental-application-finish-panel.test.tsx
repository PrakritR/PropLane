// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RentalApplicationFinishPanel } from "@/components/marketing/rental-application-finish-panel";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe("RentalApplicationFinishPanel", () => {
  it("shows thanks and get-back copy for signed-in portal applicants", () => {
    render(
      <RentalApplicationFinishPanel
        axisId="PROPLANE-TEST0001"
        email="applicant@test.proplane.local"
        emailSent
        portalFlow
        onDone={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: /application submitted/i })).toBeInTheDocument();
    expect(screen.getByText(/thanks for submitting your application/i)).toBeInTheDocument();
    expect(screen.getByText(/we'll review it and get back to you/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view my applications/i })).toHaveAttribute(
      "href",
      "/resident/applications",
    );
  });

  it("shows thanks copy for guest applicants", () => {
    render(
      <RentalApplicationFinishPanel
        axisId="PROPLANE-TEST0002"
        email="guest@example.com"
        guestFlow
        setupHref="/auth/resident-setup?token=abc"
        onDone={() => {}}
      />,
    );

    expect(screen.getByText(/thanks for submitting your application/i)).toBeInTheDocument();
    expect(screen.getByText(/we'll review it and get back to you/i)).toBeInTheDocument();
  });
});

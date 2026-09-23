// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyServiceIntakeFormState,
  ServiceIntakeFormFields,
} from "@/components/portal/service-intake-form-fields";
import { MAINTENANCE_SERVICE_OFFER_ID } from "@/lib/service-intake";

afterEach(cleanup);

const repairForm = {
  ...createEmptyServiceIntakeFormState([]),
  optionKey: `repair:${MAINTENANCE_SERVICE_OFFER_ID}`,
  categoryLabel: "Plumbing" as const,
};

const customForm = {
  ...createEmptyServiceIntakeFormState([]),
  optionKey: "addon:custom",
  title: "Extra storage",
};

describe("ServiceIntakeFormFields manager voice", () => {
  it("drops Title and Access notes on maintenance", () => {
    render(
      <ServiceIntakeFormFields catalogOffers={[]} form={repairForm} onChange={() => {}} voice="manager" />,
    );
    expect(screen.queryByText(/^Title/)).toBeNull();
    expect(screen.queryByText(/Access notes/)).toBeNull();
    expect(screen.queryByText(/Entry notes/)).toBeNull();
    expect(screen.getByText(/^Description/)).toBeTruthy();
  });

  it("keeps Title on custom add-on and hides Price limit", () => {
    render(
      <ServiceIntakeFormFields catalogOffers={[]} form={customForm} onChange={() => {}} voice="manager" />,
    );
    expect(screen.getByText(/^Title/)).toBeTruthy();
    expect(screen.queryByText(/Price limit/)).toBeNull();
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it("keeps Title, Price limit, and entry notes for the resident", () => {
    render(
      <ServiceIntakeFormFields catalogOffers={[]} form={customForm} onChange={() => {}} voice="resident" />,
    );
    expect(screen.getByText(/^Title/)).toBeTruthy();
    expect(screen.getByText(/Price limit/)).toBeTruthy();

    cleanup();
    render(
      <ServiceIntakeFormFields catalogOffers={[]} form={repairForm} onChange={() => {}} voice="resident" />,
    );
    expect(screen.getByText(/^Title/)).toBeTruthy();
    expect(screen.getByText(/Entry notes/)).toBeTruthy();
  });
});

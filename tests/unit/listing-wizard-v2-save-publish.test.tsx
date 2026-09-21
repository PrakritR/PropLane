// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const saveDraft = vi.hoisted(() => vi.fn());
const publishDraft = vi.hoisted(() => vi.fn());
const submitPending = vi.hoisted(() => vi.fn());
const updateListing = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/demo-admin-property-inventory", () => ({
	 saveManagerPropertyDraftToServer: (...args: unknown[]) => saveDraft(...args),
	 publishManagerPropertyDraftToServer: (...args: unknown[]) => publishDraft(...args),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
	 submitManagerPendingPropertyToServer: (...args: unknown[]) => submitPending(...args),
	 updateExtraListingFromSubmissionOnServer: (...args: unknown[]) => updateListing(...args),
}));
vi.mock("@/lib/manager-subscription-client", () => ({
	 loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
	 prepareListingSubmissionForPersist: vi.fn(async (sub: ManagerListingSubmissionV1) => ({ submission: sub, droppedMediaCount: 0 })),
	 listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));

import { LISTING_V2_STEPS, ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";

const stepIndex = (id: string) => LISTING_V2_STEPS.findIndex((step) => step.id === id);

function validSubmission(): ManagerListingSubmissionV1 {
	const sub = createDefaultListingSubmission();
	return {
		...sub,
		address: "142 Ash St",
		city: "Brooklyn",
		state: "NY",
		zip: "11201",
		allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
		rooms: [{ ...sub.rooms[0]!, monthlyRent: 1500 }],
	};
}

function rail(id: string) {
	const el = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`);
	if (!el) throw new Error(`Missing rail item ${id}`);
	return el;
}

beforeEach(() => {
	saveDraft.mockReset().mockResolvedValue("draft-1");
	publishDraft.mockReset().mockResolvedValue("listing-1");
	submitPending.mockReset().mockResolvedValue("listing-1");
	updateListing.mockReset().mockResolvedValue(true);
	showToast.mockReset();
});

afterEach(() => cleanup());

describe("V2 editor action availability", () => {
	it("renders an explicit Save and Publish action on every step", () => {
		const onSave = vi.fn(async () => true);
		const onClose = vi.fn();
		const onPublish = vi.fn(async () => true);
		render(
			<ListingEditorV2
				title="Ash Flats"
				submission={validSubmission()}
				onChange={() => {}}
				onClose={onClose}
				onSave={onSave}
				onPublish={onPublish}
			/>,
		);

		for (const step of LISTING_V2_STEPS) {
			fireEvent.click(rail(step.id));
			expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
		}
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(onSave).toHaveBeenCalledWith(stepIndex("review"));
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe("V2 publish gate and recovery", () => {
	it("publishes a complete listing from an early step", async () => {
		const onPublished = vi.fn();
		render(
			<ListingWizardV2
				onClose={() => {}}
				onPublished={onPublished}
				showToast={showToast}
				userId="manager-1"
				skuTier="starter"
				initialSubmission={validSubmission()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(onPublished).toHaveBeenCalledWith("listing-1"));
		expect(showToast).not.toHaveBeenCalled();
	});

	it("uses a todo readiness item to navigate and focus its actionable field, repeatedly", async () => {
		const sub = createDefaultListingSubmission();
		render(
			<ListingWizardV2
				onClose={() => {}}
				showToast={showToast}
				userId="manager-1"
				skuTier="starter"
				initialSubmission={sub}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(document.querySelector('[data-attr="listing-v2-rail-basics"]')).toHaveAttribute("aria-current", "step"));
		const address = document.querySelector<HTMLInputElement>('input[autocomplete="street-address"]')!;
		await waitFor(() => expect(address).toHaveFocus());
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(address).toHaveFocus());
		expect(submitPending).not.toHaveBeenCalled();
	});

	it("retains input after a failed Save and allows retry", async () => {
		saveDraft.mockResolvedValueOnce(null).mockResolvedValueOnce("draft-1");
		const onClose = vi.fn();
		render(
			<ListingWizardV2
				onClose={onClose}
				showToast={showToast}
				userId="manager-1"
				skuTier="starter"
				initialSubmission={createDefaultListingSubmission()}
			/>,
		);
		const address = document.querySelector<HTMLInputElement>('input[autocomplete="street-address"]')!;
		fireEvent.change(address, { target: { value: "142 Ash St" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(showToast).toHaveBeenCalled());
		expect(screen.getByDisplayValue("142 Ash St")).toBeTruthy();
		await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByTestId("listing-v2-persistence-error")).toBeNull());
		expect(onClose).not.toHaveBeenCalled();
		expect(saveDraft).toHaveBeenCalledTimes(2);
	});
});

describe("V2 persistence concurrency", () => {
	it("suppresses an overlapping Publish while Save owns the lifecycle", async () => {
		let finishSave!: (id: string | null) => void;
		saveDraft.mockImplementation(() => new Promise<string | null>((resolve) => { finishSave = resolve; }));
		render(
			<ListingWizardV2
				onClose={() => {}}
				showToast={showToast}
				userId="manager-1"
				skuTier="starter"
				initialSubmission={validSubmission()}
			/>,
		);
		const address = document.querySelector<HTMLInputElement>('input[autocomplete="street-address"]')!;
		fireEvent.change(address, { target: { value: "143 Ash St" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
		expect(submitPending).not.toHaveBeenCalled();
		finishSave("draft-1");
		await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
	});
});

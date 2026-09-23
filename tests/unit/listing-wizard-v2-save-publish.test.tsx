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
	it("renders Continue on earlier steps and Publish only on Review", () => {
		const onClose = vi.fn();
		const onPublish = vi.fn(async () => true);
		render(
			<ListingEditorV2
				title="Ash Flats"
				submission={validSubmission()}
				onChange={() => {}}
				onClose={onClose}
				onPublish={onPublish}
			/>,
		);

		for (const step of LISTING_V2_STEPS) {
			fireEvent.click(rail(step.id));
			expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
			if (step.id === "review") {
				expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
				expect(screen.queryByRole("button", { name: /^Continue to/ })).toBeNull();
			} else {
				expect(screen.getByRole("button", { name: /^Continue to/ })).toBeTruthy();
				expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
			}
		}
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		expect(onPublish).toHaveBeenCalled();
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
		fireEvent.click(rail("review"));
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
		fireEvent.click(rail("review"));
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(document.querySelector('[data-attr="listing-v2-rail-basics"]')).toHaveAttribute("aria-current", "step"));
		const address = document.querySelector<HTMLInputElement>('input[autocomplete="street-address"]')!;
		await waitFor(() => expect(address).toHaveFocus());
		fireEvent.click(rail("review"));
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => {
			const again = document.querySelector<HTMLInputElement>('input[autocomplete="street-address"]')!;
			expect(again).toHaveFocus();
		});
		expect(submitPending).not.toHaveBeenCalled();
	});
});

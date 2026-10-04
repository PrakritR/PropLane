// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";

type ModalProps = {
  onSave: (
    templates: PropertyLeaseTemplate[],
    extra?: { allowedLeaseTerms?: string[]; touchedLeaseOptions?: ("custom" | "monthToMonth")[] },
  ) => Promise<boolean>;
};
const modal: { props: ModalProps | null } = { props: null };
const saved: Array<{ saveId: string; sub: ManagerListingSubmissionV1 }> = [];
const subs = new Map<string, ManagerListingSubmissionV1>();

vi.mock("@/components/portal/property-lease-form-modal", () => ({
  PropertyLeaseFormModal: (props: ModalProps) => {
    modal.props = props;
    return null;
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/properties/all/lease",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/manager-property-save-target", () => ({
  resolveManagerListingSubmissionForPropertyId: (_m: string, id: string) => {
    const sub = subs.get(id);
    return sub ? { sub, saveTarget: { mode: "listing", saveId: id } } : null;
  },
  persistManagerListingSubmissionOnServer: async (
    target: { saveId: string },
    _m: string,
    sub: ManagerListingSubmissionV1,
  ) => {
    saved.push({ saveId: target.saveId, sub });
    return true;
  },
}));

const lease = (over: Partial<PropertyLeaseTemplate> = {}): PropertyLeaseTemplate =>
  ({
    id: "tpl-1",
    kind: "long-term",
    label: "Long-term lease",
    leaseConfigMode: "standard",
    leaseCustomKind: "terms",
    customLeaseTerms: "",
    leaseTemplateDocUrl: null,
    leaseTemplateDocName: "",
    applicationLeaseTerms: ["Long-term", "Custom"],
    ...over,
  }) as PropertyLeaseTemplate;

function subWith(allowed: string[]): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = allowed;
  sub.shortTermRentalsAllowed = allowed.includes("Short-Term Stay");
  sub.propertyLeaseTemplates = [lease({ applicationLeaseTerms: ["Long-term"] })];
  return sub;
}

afterEach(() => {
  cleanup();
  saved.length = 0;
  subs.clear();
});

describe("bulk lease save writes each property's allowed terms", () => {
  it("applies the touched checkboxes to every property, keeping each one's other terms", async () => {
    subs.set("p1", subWith(["Long-term", "Short-Term Stay"]));
    subs.set("p2", subWith(["Long-term", "Month-to-Month"]));
    render(
      <AppUiProvider>
        <ManagerPropertyLeasePanel
          sub={subs.get("p1")!}
          saveTarget={{ mode: "listing", saveId: "p1" }}
          managerUserId="mgr-1"
          propertyIds={["p1", "p2"]}
          onUpdated={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    const ok = await modal.props!.onSave([lease()], {
      allowedLeaseTerms: ["Long-term", "Custom", "Short-Term Stay"],
      touchedLeaseOptions: ["custom"],
    });
    expect(ok).toBe(true);
    expect(saved.map((s) => s.saveId)).toEqual(["p1", "p2"]);
    expect(saved[0]!.sub.allowedLeaseTerms).toEqual(["Long-term", "Custom", "Short-Term Stay"]);
    // p2 keeps its own Month-to-Month; only the touched Custom term is applied.
    expect(saved[1]!.sub.allowedLeaseTerms).toEqual(["Long-term", "Month-to-Month", "Custom"]);
  });

  it("leaves allowed terms alone when no option was touched", async () => {
    subs.set("p1", subWith(["Long-term", "Short-Term Stay"]));
    subs.set("p2", subWith(["Long-term"]));
    render(
      <AppUiProvider>
        <ManagerPropertyLeasePanel
          sub={subs.get("p1")!}
          saveTarget={{ mode: "listing", saveId: "p1" }}
          managerUserId="mgr-1"
          propertyIds={["p1", "p2"]}
          onUpdated={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    await modal.props!.onSave([lease()], undefined);
    expect(saved[0]!.sub.allowedLeaseTerms).toEqual(["Long-term", "Short-Term Stay"]);
    expect(saved[1]!.sub.allowedLeaseTerms).toEqual(["Long-term"]);
  });
});

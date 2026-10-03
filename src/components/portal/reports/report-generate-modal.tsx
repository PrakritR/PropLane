"use client";

import { PopupRecordPreview } from "@/components/portal/popup-live-preview";

import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  FormalDocumentScopeBar,
  type FormalDocumentFilterState,
} from "@/components/portal/reports/formal-document-scope-bar";
import {
  ReportFilterBar,
  type ReportFilterState,
} from "@/components/portal/reports/report-filter-bar";

export function ReportGenerateModal({
  open,
  onClose,
  tabLabel,
  showScope,
  showProperty,
  showDateRange,
  showTaxYear,
  propertyOptions,
  filters,
  onFiltersChange,
  scopeFilters,
  onScopeFiltersChange,
  onGenerate,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  tabLabel: string;
  showScope: boolean;
  showProperty: boolean;
  showDateRange: boolean;
  showTaxYear: boolean;
  propertyOptions?: { id: string; label: string }[];
  filters: ReportFilterState;
  onFiltersChange: (next: Partial<ReportFilterState>) => void;
  scopeFilters: FormalDocumentFilterState;
  onScopeFiltersChange: (next: Partial<FormalDocumentFilterState>) => void;
  onGenerate: () => void;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      title={`Generate ${tabLabel.toLowerCase()}`}
      contextPanel={<PopupRecordPreview rows={[{ label: "Report", value: tabLabel }, ...(showScope ? [{ label: "Scope", value: scopeFilters.scope }] : [])]} />}
      previewLabel="Export preview"
      preview={<PopupRecordPreview rows={[{ label: "Report", value: tabLabel }, ...(showProperty ? [{ label: "Property", value: propertyOptions?.find(property => property.id === filters.propertyId)?.label || "All properties" }] : []), ...(showDateRange ? [{ label: "From", value: filters.from }, { label: "To", value: filters.to }] : []), ...(showTaxYear ? [{ label: "Tax year", value: filters.taxYear }] : [])]} />}
      onClose={onClose}
      panelClassName="max-w-lg"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className={PORTAL_HEADER_ACTION_BTN}
            onClick={onGenerate}
            disabled={loading}
            data-attr="documents-generate-report-submit"
          >
            {loading ? "Generating…" : "Generate report"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-5">


        {showScope ? (
          <div className="space-y-3">
            <FormalDocumentScopeBar
              inline
              stacked
              filters={scopeFilters}
              onChange={onScopeFiltersChange}
            />
          </div>
        ) : null}

        <ReportFilterBar
          stacked
          showProperty={showProperty}
          showDateRange={showDateRange}
          showDaysAhead={false}
          showTaxYear={showTaxYear}
          showRunButton={false}
          propertyOptions={propertyOptions}
          filters={filters}
          onChange={onFiltersChange}
          onRun={onGenerate}
          loading={loading}
        />

      </div>
    </Modal>
  );
}

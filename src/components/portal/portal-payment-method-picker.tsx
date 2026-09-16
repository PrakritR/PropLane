"use client";

import type { ManagerVendorPayMethod } from "@/lib/manager-vendor-payment-flow";
import { MANAGER_VENDOR_PAY_METHOD_OPTIONS } from "@/lib/manager-vendor-payment-flow";

export function PortalPaymentMethodPicker({
  options,
  value,
  onChange,
  dataAttrPrefix,
}: {
  options: ManagerVendorPayMethod[];
  value: ManagerVendorPayMethod;
  onChange: (method: ManagerVendorPayMethod) => void;
  dataAttrPrefix: string;
}) {
  const visible = MANAGER_VENDOR_PAY_METHOD_OPTIONS.filter((option) => options.includes(option.id));
  if (visible.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-accent/20 px-3 py-2 text-xs text-muted">
        This vendor has not set up payment methods yet. Ask them to link their bank in their vendor
        portal.
      </p>
    );
  }

  return (
    <div className={`grid gap-2 ${visible.length > 2 ? "sm:grid-cols-3" : "grid-cols-2"}`}>
      {visible.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            data-attr={`${dataAttrPrefix}-${option.id}`}
            onClick={() => onChange(option.id)}
            className={`rounded-xl border px-3 py-3 text-left transition ${
              selected
                ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                : "border-border bg-card hover:border-primary/30"
            }`}
          >
            <p className="text-sm font-semibold text-foreground">{option.title}</p>
            <p className="mt-1 text-xs text-muted">{option.feeLabel}</p>
          </button>
        );
      })}
    </div>
  );
}

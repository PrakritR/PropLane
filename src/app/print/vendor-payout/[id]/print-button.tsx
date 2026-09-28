"use client";

import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button type="button" variant="primary" onClick={() => window.print()} data-attr="print-vendor-payout-receipt-print">
      Print
    </Button>
  );
}
